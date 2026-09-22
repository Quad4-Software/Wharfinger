import { error, isHttpError } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit } from '$lib/server/admin/http';
import { chatActor, chatFail } from '$lib/server/admin/chat';
import { CHAT_ATTACHMENT_MAX_BYTES, CHAT_ATTACHMENT_MIMES } from '$lib/server/admin/chat-files';
import { RateLimiter } from '$lib/server/http/ratelimit';

// Uploads cost disk and bandwidth on top of a normal send, so they get
// a per-user bucket beyond the shared admin limiter in hooks.
const uploadLimiter = new RateLimiter(30, 60_000);
const FILENAME_MAX = 512;

/**
 * Bounded binary body read. Mirrors readText in admin/http but keeps
 * the raw bytes; the cap is enforced while streaming so a chunked body
 * without a trustworthy content-length cannot buffer past the limit.
 */
async function readBody(request: Request): Promise<Uint8Array> {
	const len = Number(request.headers.get('content-length') ?? 0);
	if (len > CHAT_ATTACHMENT_MAX_BYTES) error(413, 'file exceeds 10 MB');
	if (request.body === null) return new Uint8Array(0);
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > CHAT_ATTACHMENT_MAX_BYTES) {
				await reader.cancel().catch(() => undefined);
				error(413, 'file exceeds 10 MB');
			}
			chunks.push(value);
		}
	} catch (err) {
		if (err && typeof err === 'object' && 'status' in err) throw err;
		error(400, 'could not read body');
	} finally {
		reader.releaseLock();
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.byteLength;
	}
	return out;
}

/**
 * Stage a file for a later send. The body is the raw file; the name
 * arrives as ?filename= and the declared type as content-type. The
 * response id is what POST .../messages takes in attachment_ids.
 */
export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const user = await chatActor(event, rt.users);
	if (!uploadLimiter.allow(`u${user.id}`)) return apiError(429, 'upload rate limit exceeded');
	const filename = event.url.searchParams.get('filename') ?? '';
	if (filename.length === 0 || filename.length > FILENAME_MAX) {
		return apiError(422, 'a filename query parameter is required');
	}
	const mime = (event.request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
	if (!CHAT_ATTACHMENT_MIMES.has(mime)) return apiError(422, 'unsupported file type');
	// Membership before the body read so a non-member cannot force
	// buffering; uploadAttachment re-checks against the row it writes.
	try {
		await rt.chat.assertMember(event.params.id, user.id);
	} catch (err) {
		return chatFail(err);
	}
	let data: Uint8Array;
	try {
		data = await readBody(event.request);
	} catch (err) {
		if (isHttpError(err)) return apiError(err.status, err.body.message);
		throw err;
	}
	try {
		const attachment = await rt.chat.uploadAttachment(event.params.id, user.id, {
			name: filename,
			mime,
			data
		});
		await audit(
			rt,
			event,
			'chat.attachment.upload',
			`room=${event.params.id} file=${attachment.name} bytes=${attachment.size}`
		);
		return apiJson({ ok: true, attachment }, 201);
	} catch (err) {
		return chatFail(err);
	}
};
