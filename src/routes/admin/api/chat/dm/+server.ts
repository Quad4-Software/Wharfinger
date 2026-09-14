import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, readJson, requireUser } from '$lib/server/admin/http';
import { chatFail } from '$lib/server/admin/chat';

/** Open (or find) the direct-message room with another user. */
export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const user = requireUser(event);
	const body = await readJson<{ userId?: unknown }>(event.request, 4096);
	const otherId = Number(body.userId);
	if (!Number.isInteger(otherId) || otherId <= 0) return apiError(422, 'invalid user id');
	try {
		const room = rt.chat.openDm(user.id, otherId);
		return apiJson({ ok: true, room });
	} catch (err) {
		return chatFail(err);
	}
};
