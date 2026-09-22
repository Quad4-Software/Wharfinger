import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { SectionError } from '$lib/server/admin/config-actions';
import { applyTomlDocument } from '$lib/server/admin/config-doc';
import { apiError, apiJson, clientIp, readJson, requirePerm } from '$lib/server/admin/http';

/**
 * Saved revisions of the effective TOML document. GET lists newest
 * first (metadata only); GET ?id= returns one document body. POST
 * {id} applies that revision through the same validation path as the
 * editor save, so a restore can never write an invalid config.
 */
export const GET: RequestHandler = async (event) => {
	const rt = getRuntime();
	requirePerm(event, 'config.raw');
	const idParam = event.url.searchParams.get('id');
	if (idParam !== null) {
		const id = Number(idParam);
		const rev = Number.isInteger(id) && id > 0 ? await rt.configStore.revision(id) : null;
		if (!rev) return apiError(404, 'revision not found');
		return apiJson(rev);
	}
	return apiJson({ revisions: await rt.configStore.revisions() });
};

export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const user = requirePerm(event, 'config.raw');
	const body = await readJson<{ id?: unknown }>(event.request, 8 * 1024);
	const id = typeof body.id === 'number' ? body.id : NaN;
	const rev = Number.isInteger(id) && id > 0 ? await rt.configStore.revision(id) : null;
	if (!rev) return apiError(404, 'revision not found');
	try {
		const r = await applyTomlDocument(
			rt,
			user,
			event.locals.perms,
			clientIp(event),
			rev.doc,
			'config.toml.restore'
		);
		return apiJson({ ok: true, overrides: r.overrides });
	} catch (err) {
		if (err instanceof SectionError) {
			return apiError(err.status, err.message, err.issues ? { issues: err.issues } : undefined);
		}
		throw err;
	}
};
