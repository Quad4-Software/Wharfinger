import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiJson, asArray, audit, readJson, requireUser } from '$lib/server/admin/http';
import { chatFail } from '$lib/server/admin/chat';

/** Create a named group room; the creator is added automatically. */
export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const user = requireUser(event);
	const body = await readJson<{ name?: unknown; members?: unknown }>(event.request, 8192);
	const name = typeof body.name === 'string' ? body.name : '';
	const members = asArray(body.members)
		.map(Number)
		.filter((n) => Number.isInteger(n) && n > 0);
	try {
		const room = rt.chat.createRoom(name, members, user.id);
		audit(rt, event, 'chat.room.create', `room=${room.id} name=${room.name}`);
		return apiJson({ ok: true, room }, 201);
	} catch (err) {
		return chatFail(err);
	}
};
