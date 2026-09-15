import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, requirePerm } from '$lib/server/admin/http';

/** Generate a one-time password-reset link for a user. */
export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const actor = requirePerm(event, 'users.manage');
	const id = Number(event.params.id);
	const target = Number.isInteger(id) ? await rt.users.byId(id) : null;
	if (!target) return apiError(404, 'unknown user');
	if (target.disabledAt !== null) return apiError(422, 'account is disabled');

	await rt.invites.revokeForUser(target.id);
	// A reset exists to evict a potentially hijacked account; waiting
	// for the link to be clicked leaves live sessions in place.
	await rt.sessions.revokeUserSessions(target.id);
	const { token } = await rt.invites.create({
		kind: 'reset',
		role: target.role,
		userId: target.id,
		createdBy: actor.id,
		ttlMs: rt.inviteTtlMs()
	});
	await audit(rt, event, 'users.reset_link', `user=${target.username}`);
	return apiJson({ url: `${event.url.origin}${rt.adminBase()}/invite/${token}` });
};
