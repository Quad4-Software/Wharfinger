import { stringify } from 'smol-toml';
import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { sectionReadPermission } from '$lib/server/admin/authz';
import { SectionError, isSectionKey } from '$lib/server/admin/config-actions';
import { applyTomlDocument, stripTomlUnfriendly } from '$lib/server/admin/config-doc';
import { apiError, apiJson, clientIp, readJson, requirePerm } from '$lib/server/admin/http';

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

export const PUT: RequestHandler = async (event) => {
	const rt = getRuntime();
	const user = requirePerm(event, 'config.raw');
	const body = await readJson<{ toml?: unknown }>(event.request, 512 * 1024);
	const text = typeof body.toml === 'string' ? body.toml : '';
	try {
		const r = await applyTomlDocument(rt, user, event.locals.perms, clientIp(event), text);
		return apiJson({ ok: true, overrides: r.overrides });
	} catch (err) {
		if (err instanceof SectionError) {
			return apiError(err.status, err.message, err.issues ? { issues: err.issues } : undefined);
		}
		throw err;
	}
};
