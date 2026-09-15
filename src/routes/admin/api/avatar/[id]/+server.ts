import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, requireUser } from '$lib/server/admin/http';

// Serve a stored avatar. The mime comes from the validated upload,
// nosniff plus a null CSP keep the bytes inert even if a polyglot
// slipped past the magic-byte checks.
export const GET: RequestHandler = async (event) => {
	requireUser(event);
	const rt = getRuntime();
	const id = Number(event.params.id);
	if (!Number.isInteger(id) || id <= 0) return apiError(404, 'not found');
	const av = await rt.users.avatarFor(id);
	if (!av) return apiError(404, 'not found');
	return new Response(Buffer.from(av.data), {
		headers: {
			'content-type': av.mime,
			'content-length': String(av.data.length),
			'x-content-type-options': 'nosniff',
			'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
			'cache-control': 'private, max-age=300, immutable'
		}
	});
};
