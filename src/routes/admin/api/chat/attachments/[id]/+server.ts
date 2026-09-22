import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { chatActor, chatFail } from '$lib/server/admin/chat';

/**
 * Download a stored attachment. Room membership is enforced in the
 * store. Uploads are user content, so the response is always a forced
 * download with nosniff plus a null CSP: nothing renders inline on the
 * admin origin regardless of the stored mime.
 */
export const GET: RequestHandler = async (event) => {
	const rt = getRuntime();
	const user = await chatActor(event, rt.users);
	try {
		const file = await rt.chat.attachmentDownload(event.params.id, user.id);
		const fallback = file.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'file';
		return new Response(Buffer.from(file.data), {
			headers: {
				'content-type': file.mime,
				'content-length': String(file.data.length),
				'content-disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
				'x-content-type-options': 'nosniff',
				'content-security-policy': "default-src 'none'",
				'cache-control': 'private, max-age=300'
			}
		});
	} catch (err) {
		return chatFail(err);
	}
};
