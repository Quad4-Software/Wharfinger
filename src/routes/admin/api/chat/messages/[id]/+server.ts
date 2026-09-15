import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, readJson } from '$lib/server/admin/http';
import { chatActor, chatFail } from '$lib/server/admin/chat';
import { emitChat } from '$lib/server/admin/chat-bus';

/** Author-only edit inside the 10 minute window. */
export const PATCH: RequestHandler = async (event) => {
	const rt = getRuntime();
	const user = await chatActor(event, rt.users);
	const id = Number(event.params.id);
	if (!Number.isInteger(id) || id <= 0) return apiError(422, 'invalid message id');
	const body = await readJson<{ body?: unknown }>(event.request, 32 * 1024);
	const raw = typeof body.body === 'string' ? body.body : '';
	try {
		const message = await rt.chat.edit(id, user.id, raw);
		emitChat({
			type: 'update',
			room: message.roomId,
			members: await rt.chat.memberIds(message.roomId),
			message
		});
		return apiJson({ ok: true, message });
	} catch (err) {
		return chatFail(err);
	}
};

/** Soft delete: the author, or a moderator holding users.manage. */
export const DELETE: RequestHandler = async (event) => {
	const rt = getRuntime();
	const user = await chatActor(event, rt.users);
	const id = Number(event.params.id);
	if (!Number.isInteger(id) || id <= 0) return apiError(422, 'invalid message id');
	const moderator = event.locals.perms?.has('users.manage') ?? false;
	try {
		const message = await rt.chat.remove(id, user.id, moderator);
		await audit(rt, event, 'chat.message.delete', `message=${id} room=${message.roomId}`);
		emitChat({
			type: 'update',
			room: message.roomId,
			members: await rt.chat.memberIds(message.roomId),
			message
		});
		return apiJson({ ok: true, message });
	} catch (err) {
		return chatFail(err);
	}
};
