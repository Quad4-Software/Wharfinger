import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, requireUser } from '$lib/server/admin/http';

// Revoke one of the caller's own push subscriptions. The delete is
// scoped by user_id so one operator cannot remove another's endpoint.
export const DELETE: RequestHandler = async (event) => {
	const rt = getRuntime();
	const user = requireUser(event);
	const id = event.params.id;
	if (!/^[a-f0-9]{24}$/.test(id)) return apiError(422, 'invalid subscription id');
	if (!(await rt.pushSubs.removeForUser(id, user.id))) {
		return apiError(404, 'subscription not found');
	}
	await audit(rt, event, 'pushsubs.revoke', `push subscription ${id}`);
	return apiJson({ ok: true });
};
