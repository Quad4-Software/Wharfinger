import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { clearSessionCookie } from '$lib/server/admin/sessions';
import { apiJson, clientIp } from '$lib/server/admin/http';

export const POST: RequestHandler = (event) => {
	const rt = getRuntime();
	if (event.locals.sessionHash) {
		rt.sessions.revoke(event.locals.sessionHash);
		rt.audit.log({
			userId: event.locals.user?.id ?? null,
			username: event.locals.user?.username ?? null,
			action: 'auth.logout',
			ip: clientIp(event)
		});
	}
	clearSessionCookie(event.cookies);
	return apiJson({ ok: true });
};
