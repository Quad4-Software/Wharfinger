import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { passkeyInfo } from '$lib/server/admin/webauthn';
import { apiJson, requireUser } from '$lib/server/admin/http';

/** List the caller's own passkeys (metadata only). */
export const GET: RequestHandler = (event) => {
	const rt = getRuntime();
	const user = requireUser(event);
	return apiJson({ passkeys: rt.passkeys.forUser(user.id).map(passkeyInfo) });
};
