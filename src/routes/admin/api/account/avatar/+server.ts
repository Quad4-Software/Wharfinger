import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, requireUser } from '$lib/server/admin/http';
import { validateAvatar, AVATAR_MAX_BYTES } from '$lib/server/admin/avatar';

/** Upload the caller's avatar as a raw image body (PNG/JPEG/WebP/GIF). */
export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const user = requireUser(event);
	// Reject on declared length before buffering the body.
	if (Number(event.request.headers.get('content-length') ?? 0) > AVATAR_MAX_BYTES) {
		return apiError(413, 'image exceeds 512 KB');
	}
	const buf = new Uint8Array(await event.request.arrayBuffer());
	if (buf.length > AVATAR_MAX_BYTES) return apiError(413, 'image exceeds 512 KB');
	const r = validateAvatar(buf);
	if ('error' in r) return apiError(422, r.error);
	await rt.users.setAvatar(user.id, buf, r.mime);
	await audit(rt, event, 'account.avatar');
	return apiJson({ ok: true });
};

/** Remove the caller's avatar. */
export const DELETE: RequestHandler = async (event) => {
	const rt = getRuntime();
	const user = requireUser(event);
	await rt.users.clearAvatar(user.id);
	await audit(rt, event, 'account.avatar.remove');
	return apiJson({ ok: true });
};
