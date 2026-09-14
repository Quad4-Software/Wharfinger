import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { hashToken, verifyAgainstDummy, verifyPassword } from '$lib/server/admin/crypto';
import { ldapAuthenticate, ldapReady } from '$lib/server/admin/ldap';
import { knownRole, resolveExternalUser } from '$lib/server/admin/external';
import { verifyTotp } from '$lib/server/admin/totp';
import { setSessionCookie } from '$lib/server/admin/sessions';
import {
	apiError,
	apiJson,
	clientIp,
	honeypotTripped,
	isSecureRequest,
	readJson
} from '$lib/server/admin/http';

const GENERIC = 'invalid username or password';

export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const ip = clientIp(event);
	const body = await readJson(event.request, 8192);
	const username = typeof body.username === 'string' ? body.username.slice(0, 128) : '';
	const password = typeof body.password === 'string' ? body.password.slice(0, 256) : '';
	const code = typeof body.totp === 'string' ? body.totp.trim() : '';

	const policy = {
		maxAttempts: rt.config.admin.login_max_attempts,
		lockoutMs: rt.config.admin.login_lockout_minutes * 60_000
	};
	const locked = rt.protection.lockedUntil(ip, policy);
	if (locked !== null) {
		return apiError(429, 'too many failed attempts; try again later', {
			retry_after: Math.ceil((locked - Date.now()) / 1000)
		});
	}
	// A username under distributed attack pays a progressive delay
	// rather than a hard lockout, so the legitimate owner can still
	// sign in from a clean source.
	if (username) {
		const delay = rt.protection.usernameDelayMs(username, policy);
		if (delay > 0) await new Promise((r) => setTimeout(r, delay));
	}

	const fail = () => {
		rt.protection.record(ip, username || null, false);
		rt.audit.log({ username: username || null, action: 'auth.login.fail', ip });
		return apiError(401, GENERIC);
	};

	// Honeypot: real users never see or fill this field.
	if (honeypotTripped(body)) return fail();
	if (!username || !password) return fail();

	let row = rt.users.rowByName(username);
	if (!row || row.source === 'ldap') {
		// LDAP path: a provisioned ldap account, or a first login that
		// provisions on success. Local accounts never fall through here.
		if (!ldapReady(rt.config.ldap)) {
			if (!row) verifyAgainstDummy(password);
			return fail();
		}
		const ident = await ldapAuthenticate(rt.config.ldap, username, password, rt.egress);
		if (!ident?.role || !knownRole(rt.roles, ident.role)) return fail();
		const user = resolveExternalUser(
			rt.users,
			'ldap',
			ident.dn,
			ident.username,
			ident.displayName,
			ident.role,
			true
		);
		if (!user) {
			rt.audit.log({ username, action: 'auth.login.disabled', ip });
			return fail();
		}
		row = rt.users.rowById(user.id);
	} else if (row.password_hash === '') {
		// Externally provisioned account (oidc): keep the timing close
		// to a real scrypt verify so the source is not revealed.
		verifyAgainstDummy(password);
		return fail();
	} else if (!verifyPassword(password, row.password_hash)) {
		return fail();
	}

	if (!row) return fail();
	const user = rt.users.byId(row.id);
	if (!user) return fail();
	if (user.disabledAt !== null) {
		rt.audit.log({ userId: user.id, username, action: 'auth.login.disabled', ip });
		return fail();
	}

	if (user.totpEnabled) {
		if (!code) return apiJson({ totp_required: true });
		const secret = rt.users.totpSecret(row);
		let ok = secret ? verifyTotp(secret, code) : false;
		if (!ok) {
			// Fall back to single-use backup codes.
			ok = rt.users.consumeBackupCode(row.id, hashToken(code));
		}
		if (!ok) return fail();
	}

	rt.protection.record(ip, username, true);
	rt.users.touchLogin(row.id);
	const token = rt.sessions.create(
		row.id,
		rt.sessionTtlMs(),
		ip,
		event.request.headers.get('user-agent')
	);
	setSessionCookie(event.cookies, token, rt.sessionTtlMs(), isSecureRequest(event));
	rt.audit.log({ userId: row.id, username, action: 'auth.login', ip });
	return apiJson({ ok: true, user });
};
