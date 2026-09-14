import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { setSessionCookie } from '$lib/server/admin/sessions';
import {
	apiError,
	apiJson,
	clientIp,
	honeypotTripped,
	isSecureRequest,
	readJson
} from '$lib/server/admin/http';
import { USERNAME_RE, checkPassword } from '$lib/server/admin/policy';

export const GET: RequestHandler = () => {
	const rt = getRuntime();
	return apiJson({ needed: rt.config.admin.allow_setup && rt.users.count() === 0 });
};

export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	if (!rt.config.admin.allow_setup || rt.users.count() > 0) {
		return apiError(404, 'setup is no longer available');
	}
	const body = await readJson(event.request, 8192);
	if (honeypotTripped(body)) return apiError(400, 'invalid submission');

	const username = typeof body.username === 'string' ? body.username.trim() : '';
	const password = typeof body.password === 'string' ? body.password : '';
	const displayName = typeof body.display_name === 'string' ? body.display_name.slice(0, 80) : '';

	if (!USERNAME_RE.test(username)) {
		return apiError(422, 'username must be 2-64 chars of a-z, 0-9, dot, dash, underscore');
	}
	const pwError = checkPassword(password, username, rt.config.admin.password_min_length);
	if (pwError) return apiError(422, pwError);

	const ip = clientIp(event);
	// Check-then-insert is one transaction: a second concurrent setup
	// post loses the race instead of minting a stealth admin.
	const user = rt.users.createFirstUser(username, password, 'admin', displayName);
	if (!user) return apiError(404, 'setup is no longer available');
	const token = rt.sessions.create(
		user.id,
		rt.sessionTtlMs(),
		ip,
		event.request.headers.get('user-agent')
	);
	setSessionCookie(event.cookies, token, rt.sessionTtlMs(), isSecureRequest(event));
	rt.audit.log({ userId: user.id, username, action: 'admin.setup', ip });
	return apiJson({ ok: true, user });
};
