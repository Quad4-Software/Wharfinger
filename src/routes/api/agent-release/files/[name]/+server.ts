import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { AgentReleaseStore } from '$lib/server/agent-release';

// Download a hosted agent binary. Path name is allowlist-validated so
// no traversal is possible; content is always octet-stream + nosniff.
export const GET: RequestHandler = ({ params }) => {
	const name = params.name;
	if (!AgentReleaseStore.validName(name)) return new Response('not found', { status: 404 });
	const body = getRuntime().agentReleases.read(name);
	if (!body) return new Response('not found', { status: 404 });
	return new Response(body as unknown as BodyInit, {
		headers: {
			'content-type': 'application/octet-stream',
			'content-length': String(body.length),
			'x-content-type-options': 'nosniff',
			'cache-control': 'public, max-age=3600, immutable'
		}
	});
};
