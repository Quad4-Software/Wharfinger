import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiJson, requirePerm } from '$lib/server/admin/http';
import { pushToken } from '$lib/server/store/push';

// Check-in URLs for push services. Tokens derive from the hub key so
// they are stable across restarts; shown only inside the panel. A URL
// alone can fake beats, so this stays manage-gated even for reads.
export const GET: RequestHandler = (event) => {
	const rt = getRuntime();
	requirePerm(event, 'status.manage');
	const urls: Record<string, string> = {};
	for (const s of rt.config.services) {
		if (s.type === 'push') urls[s.id] = `${event.url.origin}/api/push/${pushToken(rt.db, s.id)}`;
	}
	return apiJson({ urls });
};
