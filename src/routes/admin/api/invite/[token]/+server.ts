import type { RequestEvent, RequestHandler } from './$types';
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

async function issueSession(event: RequestEvent, userId: number): Promise<void> {
	const rt = getRuntime();
	const ip = clientIp(event);
	const token = await rt.sessions.create(
		userId,
		rt.sessionTtlMs(),
		ip,
		event.request.headers.get('user-agent')
	);
	setSessionCookie(event.cookies, token, rt.sessionTtlMs(), isSecureRequest(event));
}

export const GET: RequestHandler = async (event) => {
	const rt = getRuntime();
	const inv = await rt.invites.lookup(event.params.token);
	if (!inv || !rt.invites.isUsable(inv)) return apiJson({ valid: false });
	const target = inv.userId !== null ? await rt.users.byId(inv.userId) : null;
	return apiJson({
		valid: true,
		kind: inv.kind,
		role: inv.role,
		expires_at: inv.expiresAt,
		username: target?.username ?? null
	});
};

export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const ip = clientIp(event);
	const inv = await rt.invites.lookup(event.params.token);
	if (!inv || !rt.invites.isUsable(inv)) {
		return apiError(410, 'this link is invalid, expired, or already used');
	}
	const body = await readJson(event.request, 8192);
	if (honeypotTripped(body)) return apiError(400, 'invalid submission');
	const password = typeof body.password === 'string' ? body.password : '';

	if (inv.kind === 'reset') {
		const target = inv.userId !== null ? await rt.users.byId(inv.userId) : null;
		if (target?.disabledAt !== null) return apiError(410, 'this link is no longer valid');
		const pwError = checkPassword(password, target.username, rt.config.admin.password_min_length);
		if (pwError) return apiError(422, pwError);
		// Claim before mutating: a concurrent accept on the same token
		// loses the conditional update and gets a 410 instead of a
		// second working session.
		if (!(await rt.invites.tryClaim(inv.tokenHash))) {
			return apiError(410, 'this link is invalid, expired, or already used');
		}
		await rt.users.setPassword(target.id, password);
		await rt.sessions.revokeUserSessions(target.id);
		await rt.invites.revokeForUser(target.id);
		await issueSession(event, target.id);
		await rt.audit.log({
			userId: target.id,
			username: target.username,
			action: 'auth.password_reset',
			ip
		});
		return apiJson({ ok: true });
	}

	// kind === 'invite': create a new account.
	const username = typeof body.username === 'string' ? body.username.trim() : '';
	const displayName = typeof body.display_name === 'string' ? body.display_name.slice(0, 80) : '';
	if (!USERNAME_RE.test(username)) {
		return apiError(422, 'username must be 2-64 chars of a-z, 0-9, dot, dash, underscore');
	}
	const pwError = checkPassword(password, username, rt.config.admin.password_min_length);
	if (pwError) return apiError(422, pwError);
	if (await rt.users.rowByName(username)) return apiError(409, 'that username is taken');
	if (!(await rt.roles.exists(inv.role))) {
		return apiError(422, `the role "${inv.role}" no longer exists; ask for a new invite`);
	}

	if (!(await rt.invites.tryClaim(inv.tokenHash))) {
		return apiError(410, 'this link is invalid, expired, or already used');
	}
	let user;
	try {
		user = await rt.users.create(username, password, inv.role, displayName);
	} catch {
		return apiError(409, 'that username is taken');
	}
	await issueSession(event, user.id);
	await rt.audit.log({
		userId: user.id,
		username,
		action: 'auth.invite_accept',
		detail: `role=${inv.role}`,
		ip
	});
	return apiJson({ ok: true, user });
};
