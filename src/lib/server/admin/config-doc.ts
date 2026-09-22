import { parse } from 'smol-toml';
import type { Runtime } from '$lib/server/runtime';
import { ConfigError } from '$lib/server/config/load';
import { sectionsEqual, validateMergedDoc } from '$lib/server/config/effective';
import { SECTION_KEYS } from '$lib/server/config/schema';
import { sectionPermission } from './authz';
import { SectionError, isSectionKey } from './config-actions';
import type { User } from './users';

// TOML cannot represent undefined; normalize to plain JSON-safe values.
export function stripTomlUnfriendly(v: unknown): unknown {
	if (v === undefined) return null;
	if (Array.isArray(v)) return v.map(stripTomlUnfriendly);
	if (v !== null && typeof v === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, val] of Object.entries(v)) {
			if (val !== undefined) out[k] = stripTomlUnfriendly(val);
		}
		return out;
	}
	return v;
}

/**
 * Apply a full TOML document: diff each writable top-level section
 * against the file config, store overrides only for what changed,
 * validate the merged result, then record a revision so the editor's
 * history can roll back. Throws SectionError on validation or
 * permission failures.
 */
export async function applyTomlDocument(
	rt: Runtime,
	user: User,
	perms: ReadonlySet<string> | null,
	ip: string,
	text: string,
	action = 'config.toml.save'
): Promise<{ overrides: string[] }> {
	if (!text.trim()) throw new SectionError(422, 'document is empty');

	let raw: unknown;
	try {
		raw = parse(text);
	} catch (err) {
		throw new SectionError(422, `invalid TOML: ${(err as Error).message}`);
	}
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new SectionError(422, 'invalid TOML document');
	}
	const doc = raw as Record<string, unknown>;
	const eff = rt.effective();

	// Compute the new override set, but only over sections the actor
	// may write. Protected sections are never diffed or cleared, and
	// an explicit edit attempt is rejected rather than silently ignored.
	const denied = Object.keys(doc).filter(
		(k) => isSectionKey(k) && !perms?.has(sectionPermission(k))
	);
	if (denied.length > 0) {
		const stillMatches = denied.filter((k) => sectionsEqual(doc[k], eff.raw[k]));
		const changed = denied.filter((k) => !stillMatches.includes(k));
		if (changed.length > 0) {
			throw new SectionError(
				403,
				`insufficient permissions to modify section(s): ${changed.join(', ')}`
			);
		}
	}

	const writable = SECTION_KEYS.filter((k) => perms?.has(sectionPermission(k)));
	const ARRAY_SECTIONS = new Set(['services', 'incidents', 'maintenance', 'pages', 'links']);
	const next = new Map<string, unknown>();
	for (const key of writable) {
		const fileVal = eff.fileRaw[key];
		const docVal = doc[key];
		if (docVal === undefined) {
			if (fileVal !== undefined) next.set(key, ARRAY_SECTIONS.has(key) ? [] : {});
		} else if (!sectionsEqual(docVal, fileVal)) {
			next.set(key, docVal);
		}
	}

	// Validate the merged result before touching the store.
	const merged = new Map<string, unknown>([...eff.overrides.entries()].map(([k, o]) => [k, o.raw]));
	for (const [k, v] of next) merged.set(k, v);
	try {
		const validated = validateMergedDoc(eff.fileRaw, merged, 'TOML editor');
		if (!validated.admin.enabled) {
			throw new SectionError(
				422,
				'disabling the panel from inside itself would lock everyone out; set admin.enabled = false in wharfinger.toml or WHARFINGER_ADMIN_ENABLED=false instead'
			);
		}
	} catch (err) {
		if (err instanceof ConfigError) throw new SectionError(422, 'invalid config', err.message);
		throw err;
	}

	for (const key of writable) {
		if (next.has(key)) await rt.configStore.set(key, next.get(key), user.username);
		else await rt.configStore.clear(key);
	}
	await rt.reloadConfig();
	await rt.configStore.recordRevision(text, user.username);
	await rt.audit.log({
		userId: user.id,
		username: user.username,
		action,
		detail: `overrides=${[...next.keys()].join(',') || 'none'}`,
		ip
	});
	return { overrides: [...next.keys()] };
}
