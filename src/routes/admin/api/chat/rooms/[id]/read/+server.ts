import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, readJson } from '$lib/server/admin/http';
import { chatActor, chatFail } from '$lib/server/admin/chat';

/** Advance the caller's read cursor; clamps to the room's max id. */
export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const user = await chatActor(event, rt.users);
	const body = await readJson<{ messageId?: unknown }>(event.request, 4096);
	const messageId = Number(body.messageId);
	if (!Number.isInteger(messageId) || messageId <= 0) {
		return apiError(422, 'invalid message id');
	}
	try {
		await rt.chat.markRead(event.params.id, user.id, messageId);
		return apiJson({ ok: true });
	} catch (err) {
		return chatFail(err);
	}
};
