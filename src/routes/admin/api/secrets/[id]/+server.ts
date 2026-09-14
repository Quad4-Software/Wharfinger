import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, readJson, requirePerm } from '$lib/server/admin/http';
import { getSecretStore, SecretError } from '$lib/server/secrets/store';

function parseEntries(v: unknown): Record<string, string> | null {
	if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
	const out: Record<string, string> = {};
	for (const [k, val] of Object.entries(v)) {
		if (typeof val !== 'string') return null;
		out[k] = val;
	}
	return out;
}

interface PutBody {
	name?: unknown;
	entries?: unknown;
}

// Whole-map replace: entries overwrites every key in the set.
export const PUT: RequestHandler = async (event) => {
	requirePerm(event, 'secrets.manage');
	const rt = getRuntime();
	const id = event.params.id;
	const body = await readJson<PutBody>(event.request, 512 * 1024);

	const patch: { name?: string; entries?: Record<string, string> } = {};
	if (body.name !== undefined) {
		if (typeof body.name !== 'string') return apiError(422, 'name must be a string');
		patch.name = body.name;
	}
	if (body.entries !== undefined) {
		const entries = parseEntries(body.entries);
		if (entries === null) return apiError(422, 'entries must be an object of string values');
		patch.entries = entries;
	}

	try {
		const set = getSecretStore(rt.db).put(id, patch);
		audit(rt, event, 'secrets.update', `id=${id} keys=${set.keys.length}`);
		return apiJson({ ok: true, set });
	} catch (err) {
		if (err instanceof SecretError) return apiError(err.status, err.message);
		throw err;
	}
};

export const DELETE: RequestHandler = (event) => {
	requirePerm(event, 'secrets.manage');
	const rt = getRuntime();
	const id = event.params.id;
	if (!getSecretStore(rt.db).remove(id)) return apiError(404, 'secret set not found');
	audit(rt, event, 'secrets.delete', `id=${id}`);
	return apiJson({ ok: true });
};
