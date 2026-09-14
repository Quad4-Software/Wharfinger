import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';

// Release manifest for hub-hosted agent updates. Public like any
// release asset; the agent pins the advertised sha256 so tampering
// fails verification before install.
export const GET: RequestHandler = () => {
	const m = getRuntime().agentReleases.manifest();
	if (!m) return json({ error: 'no releases hosted' }, { status: 404 });
	return json(m, { headers: { 'cache-control': 'public, max-age=60' } });
};
