import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiJson, requireUser } from '$lib/server/admin/http';

// Self-service list: a signed-in operator sees only the push
// subscriptions bound to their own account. Endpoints are the push
// credentials, so they never appear in other users' responses.
export const GET: RequestHandler = async (event) => {
	const rt = getRuntime();
	const user = requireUser(event);
	const subs = await rt.pushSubs.listForUser(user.id);
	return apiJson({
		subs: subs.map((s) => ({
			id: s.id,
			endpoint: s.endpoint,
			userAgent: s.userAgent,
			createdAt: s.createdAt,
			lastSeenAt: s.lastSeenAt,
			disabled: s.disabledAt !== null
		}))
	});
};
