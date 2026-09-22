import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, readJson, requirePerm } from '$lib/server/admin/http';
import { getSecretStore, SecretError } from '$lib/server/secrets/store';

// Version metadata only: numbers, changed key names, actor, time.
// Values are sealed per version and never leave the store.
export const GET: RequestHandler = async (event) => {
	requirePerm(event, 'secrets.manage');
	const rt = getRuntime();
	const store = getSecretStore(rt.db);
	const id = event.params.id;
	if (!(await store.get(id))) return apiError(404, 'secret set not found');
	return apiJson({ versions: await store.versions(id) });
};

interface RestoreBody {
	version?: unknown;
}

/**
 * Point-in-time restore: the named version's map is rewritten as the
 * current map, which itself appends a new version row. Nothing is
 * lost; restoring back just picks the previous version again.
 */
export const POST: RequestHandler = async (event) => {
	const user = requirePerm(event, 'secrets.manage');
	const rt = getRuntime();
	const id = event.params.id;
	const body = await readJson<RestoreBody>(event.request, 8192);
	const version = body.version;
	if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
		return apiError(422, 'version must be a positive integer');
	}
	try {
		const set = await getSecretStore(rt.db).restore(id, version, user.username);
		await audit(rt, event, 'secrets.restore', `id=${id} name=${set.name} version=${version}`);
		return apiJson({ ok: true, set });
	} catch (err) {
		if (err instanceof SecretError) return apiError(err.status, err.message);
		throw err;
	}
};
