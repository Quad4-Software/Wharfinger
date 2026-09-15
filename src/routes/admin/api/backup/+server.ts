import type { RequestHandler } from './$types';
import { getRuntime, type Runtime } from '$lib/server/runtime';
import { apiError, apiJson, audit, clientIp, readJson, requirePerm } from '$lib/server/admin/http';
import {
	isPassphraseEnvelope,
	openWithPassphrase,
	sealWithPassphrase
} from '$lib/server/admin/crypto';
import { SectionError, saveSectionValue } from '$lib/server/admin/config-actions';
import { exportData, importData } from '$lib/server/admin/backup-data';
import { SECTION_KEYS, type SectionKey } from '$lib/server/config/schema';

// Full-config export/import. Sections validate through the same
// merged-schema path as individual section edits, so an import can
// never land a config the panel itself would reject.
const EXPORTABLE = new Set<SectionKey>(
	SECTION_KEYS.filter((k) => k !== 'admin' && k !== 'oidc' && k !== 'ldap')
);

// Export the raw merged document, not the resolved config: ${VAR}
// placeholders survive the round-trip instead of baking resolved
// secrets into the backup file and later overrides.
function exportConfig(rt: Runtime): Record<string, unknown> {
	const raw = rt.effective().raw;
	const config: Record<string, unknown> = {};
	for (const k of EXPORTABLE) config[k] = raw[k];
	return config;
}

async function exportDoc(
	rt: Runtime,
	passphrase?: string,
	full = false
): Promise<Record<string, unknown>> {
	const config = exportConfig(rt);
	const data = full ? await exportData(rt.db) : undefined;
	if (passphrase) {
		return {
			format: 'wharfinger-backup',
			version: 1,
			exportedAt: Date.now(),
			encrypted: sealWithPassphrase(JSON.stringify({ config, data }), passphrase)
		};
	}
	return {
		format: 'wharfinger-backup',
		version: 1,
		exportedAt: Date.now(),
		config,
		...(data ? { data } : {})
	};
}

export const GET: RequestHandler = async (event) => {
	const rt = getRuntime();
	requirePerm(event, 'admin.settings');
	const enc = event.url.searchParams.get('enc');
	const full = event.url.searchParams.get('full') === '1';
	return apiJson(await exportDoc(rt, enc ?? undefined, full));
};

export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const user = requirePerm(event, 'admin.settings');
	const body = await readJson<{
		config?: unknown;
		data?: unknown;
		mode?: unknown;
		passphrase?: unknown;
		full?: unknown;
	}>(event.request, 8 * 1024 * 1024);

	// A body carrying only a passphrase is an encrypted export request;
	// riding POST keeps the passphrase out of request URLs and logs.
	if (body.config === undefined) {
		const pw = typeof body.passphrase === 'string' ? body.passphrase : '';
		if (!pw) return apiError(422, 'config object is required');
		return apiJson(await exportDoc(rt, pw, body.full === true));
	}

	const merge = body.mode === 'merge';
	let incoming: Record<string, unknown>;
	let dataIn: unknown = body.data;
	if (isPassphraseEnvelope(body.config)) {
		const pw = typeof body.passphrase === 'string' ? body.passphrase : '';
		if (!pw) return apiError(400, 'passphrase required for encrypted backup');
		let parsed: unknown;
		try {
			const plain = openWithPassphrase(body.config, pw);
			parsed = plain === null ? null : JSON.parse(plain);
		} catch {
			parsed = null;
		}
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return apiError(400, 'invalid passphrase or corrupt backup');
		}
		// New envelopes carry {config, data}; legacy envelopes were the
		// config map itself, which never had a `config` section key.
		const env = parsed as Record<string, unknown>;
		if (env.config !== null && typeof env.config === 'object' && !Array.isArray(env.config)) {
			incoming = env.config as Record<string, unknown>;
			dataIn = env.data;
		} else {
			incoming = env;
		}
	} else {
		if (body.config === null || typeof body.config !== 'object' || Array.isArray(body.config)) {
			return apiError(422, 'config object is required');
		}
		incoming = body.config as Record<string, unknown>;
	}

	const applied: string[] = [];
	const failed: { section: string; error: string }[] = [];
	for (const [section, value] of Object.entries(incoming)) {
		if (!EXPORTABLE.has(section as SectionKey)) {
			failed.push({ section, error: 'not an importable section' });
			continue;
		}
		let valueToWrite = value;
		if (merge && section === 'services' && Array.isArray(value)) {
			// Merge unions by service id; imported entries win conflicts.
			const byId = new Map(rt.config.services.map((s) => [s.id, s] as const));
			for (const s of value as { id?: string }[]) {
				if (typeof s.id === 'string') byId.set(s.id, s as never);
			}
			valueToWrite = [...byId.values()];
		}
		try {
			await saveSectionValue(
				rt,
				user,
				clientIp(event),
				section as SectionKey,
				valueToWrite,
				undefined,
				'config.backup.import'
			);
			applied.push(section);
		} catch (err) {
			failed.push({
				section,
				error: err instanceof SectionError ? err.message : 'validation failed'
			});
		}
	}
	let dataApplied: string[] = [];
	let dataFailed: { table: string; error: string }[] = [];
	if (dataIn !== null && typeof dataIn === 'object' && !Array.isArray(dataIn)) {
		const res = await importData(rt.db, dataIn as Record<string, unknown>);
		dataApplied = res.applied;
		dataFailed = res.failed;
	} else if (dataIn !== undefined) {
		dataFailed = [{ table: 'data', error: 'bad data object' }];
	}
	await audit(
		rt,
		event,
		'config.backup.import',
		`applied=${applied.join(',') || 'none'} failed=${failed.map((f) => f.section).join(',') || 'none'} tables=${dataApplied.join(',') || 'none'}`
	);
	const bad = failed.length + dataFailed.length;
	return apiJson(
		{
			applied,
			failed,
			data: { applied: dataApplied, failed: dataFailed },
			ok: bad === 0
		},
		bad === 0 ? 200 : applied.length + dataApplied.length > 0 ? 207 : 422
	);
};
