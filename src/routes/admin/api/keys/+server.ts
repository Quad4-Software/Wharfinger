import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import {
	apiError,
	apiJson,
	asArray,
	asString,
	audit,
	readJson,
	requirePerm
} from '$lib/server/admin/http';

// Automation API key management. The raw token is returned exactly
// once at creation; only its sha256 hash is stored.

export const GET: RequestHandler = (event) => {
	const rt = getRuntime();
	requirePerm(event, 'admin.settings');
	return apiJson({ keys: rt.apiKeys.list() });
};

export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const user = requirePerm(event, 'admin.settings');
	const body = await readJson<{ name?: unknown; scopes?: unknown }>(event.request, 16 * 1024);
	const name = asString(body.name, 128)?.trim();
	if (!name) return apiError(422, 'name is required');
	const scopes = asArray(body.scopes)
		.filter((s): s is 'read' | 'write' => s === 'read' || s === 'write')
		.filter((s, i, a) => a.indexOf(s) === i);
	if (scopes.length === 0) return apiError(422, 'scopes must include read and/or write');
	const { key, token } = rt.apiKeys.create(name, scopes, user.username);
	audit(rt, event, 'apikeys.create', `${name} (${scopes.join('+')})`);
	return apiJson({ key, token }, 201);
};

export const DELETE: RequestHandler = (event) => {
	const rt = getRuntime();
	requirePerm(event, 'admin.settings');
	const id = Number(event.url.searchParams.get('id'));
	if (!Number.isInteger(id) || id <= 0) return apiError(422, 'id is required');
	if (!rt.apiKeys.remove(id)) return apiError(404, 'key not found');
	audit(rt, event, 'apikeys.delete', `key ${id}`);
	return apiJson({ ok: true });
};

export const PATCH: RequestHandler = async (event) => {
	const rt = getRuntime();
	requirePerm(event, 'admin.settings');
	const body = await readJson<{ id?: unknown; disabled?: unknown }>(event.request, 16 * 1024);
	const id = Number(body.id);
	if (!Number.isInteger(id) || id <= 0) return apiError(422, 'id is required');
	if (typeof body.disabled !== 'boolean') return apiError(422, 'disabled must be a boolean');
	if (!rt.apiKeys.setDisabled(id, body.disabled)) return apiError(404, 'key not found');
	audit(rt, event, 'apikeys.toggle', `key ${id} disabled=${String(body.disabled)}`);
	return apiJson({ ok: true });
};
