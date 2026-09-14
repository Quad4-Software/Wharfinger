import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, readJson, requirePerm } from '$lib/server/admin/http';
import { getSecretStore, SecretError } from '$lib/server/secrets/store';

export const GET: RequestHandler = (event) => {
	requirePerm(event, 'secrets.manage');
	const rt = getRuntime();
	// Metadata and key names only; values never leave the store sealed.
	return apiJson({ sets: getSecretStore(rt.db).list() });
};

function parseEntries(v: unknown): Record<string, string> | null {
	if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
	const out: Record<string, string> = {};
	for (const [k, val] of Object.entries(v)) {
		if (typeof val !== 'string') return null;
		out[k] = val;
	}
	return out;
}

interface CreateBody {
	name?: unknown;
	entries?: unknown;
}

export const POST: RequestHandler = async (event) => {
	requirePerm(event, 'secrets.manage');
	const rt = getRuntime();
	const body = await readJson<CreateBody>(event.request, 512 * 1024);
	const entries = parseEntries(body.entries ?? {});
	if (entries === null) return apiError(422, 'entries must be an object of string values');
	try {
		const set = getSecretStore(rt.db).create(
			typeof body.name === 'string' ? body.name : '',
			entries
		);
		audit(rt, event, 'secrets.create', `id=${set.id} name=${set.name} keys=${set.keys.length}`);
		return apiJson({ ok: true, set }, 201);
	} catch (err) {
		if (err instanceof SecretError) return apiError(err.status, err.message);
		throw err;
	}
};
