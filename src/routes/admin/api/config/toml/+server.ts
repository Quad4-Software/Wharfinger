import { parse, stringify } from 'smol-toml';
import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { ConfigError } from '$lib/server/config/load';
import { sectionsEqual, validateMergedDoc } from '$lib/server/config/effective';
import { SECTION_KEYS, type SectionKey } from '$lib/server/config/schema';
import { sectionPermission, sectionReadPermission } from '$lib/server/admin/authz';
import { apiError, apiJson, audit, readJson, requirePerm } from '$lib/server/admin/http';

/**
 * Raw document editor. GET returns the effective config serialized to
 * TOML. PUT diffs each top-level section against the file config and
 * stores overrides only for sections that changed, so the file always
 * stays the source of truth underneath.
 *
 * config.raw alone is not enough: every section is additionally gated
 * by its own permission so a raw-editor grant cannot rewrite admin,
 * oidc, or ldap and escalate into authentication control. Sections the
 * actor may not read are omitted from GET, and PUT only ever touches
 * sections the actor may write, so a round-trip of the filtered doc
 * can never clear protected overrides.
 */
export const GET: RequestHandler = (event) => {
	const rt = getRuntime();
	requirePerm(event, 'config.raw');
	const eff = rt.effective();
	const doc: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(eff.raw)) {
		if (isSectionKey(k) && event.locals.perms?.has(sectionReadPermission(k))) doc[k] = v;
	}
	return apiJson({
		toml: stringify(stripTomlUnfriendly(doc)),
		overrides: [...eff.overrides.keys()].filter(
			(k) => isSectionKey(k) && event.locals.perms?.has(sectionReadPermission(k))
		)
	});
};

function isSectionKey(v: string): v is SectionKey {
	return (SECTION_KEYS as readonly string[]).includes(v);
}

export const PUT: RequestHandler = async (event) => {
	const rt = getRuntime();
	const user = requirePerm(event, 'config.raw');
	const body = await readJson<{ toml?: unknown }>(event.request, 512 * 1024);
	const text = typeof body.toml === 'string' ? body.toml : '';
	if (!text.trim()) return apiError(422, 'document is empty');

	let raw: unknown;
	try {
		raw = parse(text);
	} catch (err) {
		return apiError(422, `invalid TOML: ${(err as Error).message}`);
	}
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		return apiError(422, 'invalid TOML document');
	}
	const doc = raw as Record<string, unknown>;
	const eff = rt.effective();

	// Compute the new override set, but only over sections the actor
	// may write. Protected sections are never diffed or cleared, and
	// an explicit edit attempt is rejected rather than silently ignored.
	const denied = Object.keys(doc).filter(
		(k) => isSectionKey(k) && !event.locals.perms?.has(sectionPermission(k))
	);
	if (denied.length > 0) {
		const stillMatches = denied.filter((k) => sectionsEqual(doc[k], eff.raw[k]));
		const changed = denied.filter((k) => !stillMatches.includes(k));
		if (changed.length > 0) {
			return apiError(403, `insufficient permissions to modify section(s): ${changed.join(', ')}`);
		}
	}

	const writable = SECTION_KEYS.filter((k) => event.locals.perms?.has(sectionPermission(k)));
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
	try {
		const merged = new Map<string, unknown>(
			[...eff.overrides.entries()].map(([k, o]) => [k, o.raw])
		);
		for (const [k, v] of next) merged.set(k, v);
		const validated = validateMergedDoc(eff.fileRaw, merged, 'TOML editor');
		if (!validated.admin.enabled) {
			return apiError(
				422,
				'disabling the panel from inside itself would lock everyone out; set admin.enabled = false in wharfinger.toml or WHARFINGER_ADMIN_ENABLED=false instead'
			);
		}
	} catch (err) {
		if (err instanceof ConfigError) {
			return apiError(422, 'invalid config', { issues: err.message });
		}
		throw err;
	}

	for (const key of writable) {
		if (next.has(key)) await rt.configStore.set(key, next.get(key), user.username);
		else await rt.configStore.clear(key);
	}
	await rt.reloadConfig();
	await audit(rt, event, 'config.toml.save', `overrides=${[...next.keys()].join(',') || 'none'}`);
	return apiJson({ ok: true, overrides: [...next.keys()] });
};

// TOML cannot represent undefined; normalize to plain JSON-safe values.
function stripTomlUnfriendly(v: unknown): unknown {
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
