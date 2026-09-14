import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, readJson } from '$lib/server/admin/http';
import { chatActor, chatFail } from '$lib/server/admin/chat';

// Member id list; the ws bridge calls this (internal token + user
// claim) to validate typing fan-out, browsers can call it too.
export const GET: RequestHandler = (event) => {
	const rt = getRuntime();
	const user = chatActor(event, rt.users);
	try {
		rt.chat.roomInfoFor(event.params.id, user.id);
		return apiJson({ members: rt.chat.memberIds(event.params.id) });
	} catch (err) {
		return chatFail(err);
	}
};

/** Any current member may add another enabled user to a room. */
export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const user = chatActor(event, rt.users);
	const body = await readJson<{ userId?: unknown }>(event.request, 4096);
	const target = Number(body.userId);
	if (!Number.isInteger(target) || target <= 0) return apiError(422, 'invalid user id');
	try {
		rt.chat.addMember(event.params.id, user.id, target);
		audit(rt, event, 'chat.member.add', `room=${event.params.id} user=${target}`);
		return apiJson({ ok: true, room: rt.chat.roomInfoFor(event.params.id, user.id) });
	} catch (err) {
		return chatFail(err);
	}
};
