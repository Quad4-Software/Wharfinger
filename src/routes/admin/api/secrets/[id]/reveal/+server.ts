import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, readJson, requirePerm } from '$lib/server/admin/http';
import { getSecretStore, resolveSecret } from '$lib/server/secrets/store';

interface RevealBody {
	key?: unknown;
}

/**
 * Reveal a single value by key. The audit entry records the set and
 * key name, never the value itself.
 */
export const POST: RequestHandler = async (event) => {
	requirePerm(event, 'secrets.manage');
	const rt = getRuntime();
	const id = event.params.id;
	const body = await readJson<RevealBody>(event.request, 8192);
	const key = typeof body.key === 'string' ? body.key : '';
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return apiError(422, 'invalid key name');
	if (!(await getSecretStore(rt.db).get(id))) return apiError(404, 'secret set not found');
	const value = await resolveSecret(rt.db, `secret:${id}:${key}`);
	if (value === null) return apiError(404, 'key not found');
	await audit(rt, event, 'secrets.reveal', `set=${id} key=${key}`);
	return apiJson({ ok: true, key, value });
};
