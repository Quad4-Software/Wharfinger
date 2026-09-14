import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { AgentReleaseStore, RELEASE_FILE_MAX_BYTES } from '$lib/server/agent-release';
import { apiError, apiJson, audit, requirePerm } from '$lib/server/admin/http';

// Hosted agent binaries for air-gapped fleets. Upload takes the raw
// binary as the body with ?name= and ?version=; sha256 is computed
// server-side so the manifest never trusts a client-supplied digest.

export const GET: RequestHandler = (event) => {
	requirePerm(event, 'agents.manage');
	const rt = getRuntime();
	return apiJson({ manifest: rt.agentReleases.manifest(), files: rt.agentReleases.list() });
};

export const POST: RequestHandler = async (event) => {
	requirePerm(event, 'agents.manage');
	const rt = getRuntime();
	const name = event.url.searchParams.get('name') ?? '';
	const version = event.url.searchParams.get('version') ?? '';
	if (!AgentReleaseStore.validName(name)) return apiError(422, 'invalid file name');
	if (!AgentReleaseStore.validVersion(version)) return apiError(422, 'invalid version');
	const len = Number(event.request.headers.get('content-length') ?? 0);
	if (len > RELEASE_FILE_MAX_BYTES) return apiError(413, 'file too large');
	const body = new Uint8Array(await event.request.arrayBuffer());
	if (body.length === 0) return apiError(422, 'empty body');
	if (body.length > RELEASE_FILE_MAX_BYTES) return apiError(413, 'file too large');
	const row = rt.agentReleases.put(name, version, body);
	audit(rt, event, 'agent.release.upload', `${name} ${version} (${row.size} bytes)`);
	return apiJson(row);
};

export const DELETE: RequestHandler = (event) => {
	requirePerm(event, 'agents.manage');
	const rt = getRuntime();
	const name = event.url.searchParams.get('name') ?? '';
	if (!AgentReleaseStore.validName(name)) return apiError(422, 'invalid file name');
	if (!rt.agentReleases.remove(name)) return apiError(404, 'unknown file');
	audit(rt, event, 'agent.release.delete', name);
	return apiJson({ ok: true });
};
