import type { RequestEvent } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, asString, audit, readJson, requireUser } from '$lib/server/admin/http';

function rowId(event: RequestEvent): number | null {
	const id = Number(event.params.id);
	return Number.isInteger(id) && id > 0 ? id : null;
}

/** Rename one of the caller's own passkeys. */
export const PATCH: RequestHandler = async (event) => {
	const rt = getRuntime();
	const user = requireUser(event);
	const id = rowId(event);
	if (id === null) return apiError(404, 'unknown passkey');
	const body = await readJson<{ name?: unknown }>(event.request, 8192);
	const name = asString(body.name, 80);
	if (!name) return apiError(422, 'name is required');
	if (!rt.passkeys.rename(id, user.id, name)) return apiError(404, 'unknown passkey');
	audit(rt, event, 'account.passkey.rename', name);
	return apiJson({ ok: true });
};

/** Delete one of the caller's own passkeys. Self-service only in v1. */
export const DELETE: RequestHandler = (event) => {
	const rt = getRuntime();
	const user = requireUser(event);
	const id = rowId(event);
	if (id === null) return apiError(404, 'unknown passkey');
	const removed = rt.passkeys.remove(id, user.id);
	if (!removed) return apiError(404, 'unknown passkey');
	audit(rt, event, 'account.passkey.remove', removed.name || undefined);
	return apiJson({ ok: true });
};
