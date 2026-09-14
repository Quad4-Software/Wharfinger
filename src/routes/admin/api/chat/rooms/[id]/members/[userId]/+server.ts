import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit } from '$lib/server/admin/http';
import { chatActor, chatFail } from '$lib/server/admin/chat';

// Remove a member: leaving yourself is always allowed; removing
// someone else needs the room creator or users.manage.
export const DELETE: RequestHandler = (event) => {
	const rt = getRuntime();
	const user = chatActor(event, rt.users);
	const target = Number(event.params.userId);
	if (!Number.isInteger(target) || target <= 0) return apiError(422, 'invalid user id');
	const admin = event.locals.perms?.has('users.manage') ?? false;
	try {
		rt.chat.removeMember(event.params.id, user.id, target, admin);
		audit(rt, event, 'chat.member.remove', `room=${event.params.id} user=${target}`);
		return apiJson({ ok: true });
	} catch (err) {
		return chatFail(err);
	}
};
