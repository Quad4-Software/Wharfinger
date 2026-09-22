import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, readJson } from '$lib/server/admin/http';
import { chatActor, chatFail } from '$lib/server/admin/chat';
import { emitChat } from '$lib/server/admin/chat-bus';

// History, newest page first when before is omitted. Membership is
// enforced inside the store.
export const GET: RequestHandler = async (event) => {
	const rt = getRuntime();
	const user = await chatActor(event, rt.users);
	const rawBefore = event.url.searchParams.get('before');
	const before = rawBefore === null ? undefined : Number(rawBefore);
	if (before !== undefined && (!Number.isInteger(before) || before <= 0)) {
		return apiError(422, 'invalid before cursor');
	}
	try {
		const page = await rt.chat.list(event.params.id, user.id, before);
		return apiJson(page);
	} catch (err) {
		return chatFail(err);
	}
};

// Send a message. The ws bridge reaches this route with the internal
// token + x-chat-user claim; the response carries the member id list
// so both callers can fan the stored message out to live sockets.
export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const user = await chatActor(event, rt.users);
	const body = await readJson<{ body?: unknown; attachment_ids?: unknown }>(
		event.request,
		32 * 1024
	);
	const raw = typeof body.body === 'string' ? body.body : '';
	// Ids returned by POST ../attachments; the store claims them only
	// when they belong to this room, this uploader, and no message yet.
	const attachmentIds: string[] = [];
	if (body.attachment_ids !== undefined) {
		if (!Array.isArray(body.attachment_ids)) {
			return apiError(422, 'invalid attachment_ids');
		}
		for (const x of body.attachment_ids as unknown[]) {
			if (typeof x !== 'string' || x.length === 0 || x.length > 64) {
				return apiError(422, 'invalid attachment_ids');
			}
			attachmentIds.push(x);
		}
	}
	try {
		const message = await rt.chat.send(event.params.id, user.id, raw, attachmentIds);
		const members = await rt.chat.memberIds(event.params.id);
		emitChat({ type: 'message', room: event.params.id, members, message });
		return apiJson({ ok: true, message, members }, 201);
	} catch (err) {
		return chatFail(err);
	}
};
