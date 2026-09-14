import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { hashToken } from '$lib/server/admin/crypto';
import { verifyTotp } from '$lib/server/admin/totp';
import { setSessionCookie } from '$lib/server/admin/sessions';
import { clientDataChallenge, relyingParty } from '$lib/server/admin/webauthn';
import { apiError, apiJson, clientIp, isSecureRequest, readJson } from '$lib/server/admin/http';

// One opaque failure for every rejection, so responses do not reveal
// which accounts exist, hold passkeys, or are disabled.
const GENERIC = 'passkey sign-in failed';

/**
 * Step 2 of passkey sign-in: verify the assertion against the stored
 * single-use challenge, enforce the TOTP factor when the account has
 * one, reject cloned-authenticator counters, then create a session
 * exactly like the password path.
 */
export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const ip = clientIp(event);
	const body = await readJson<{ response?: unknown; totp?: unknown }>(event.request, 16 * 1024);
	// Validate through a deep-optional view before trusting the shape;
	// the full type is asserted only once the nested fields exist.
	const raw = body.response as
		{ id?: unknown; response?: { clientDataJSON?: unknown } } | undefined;
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

	const fail = (username: string | null = null) => {
		rt.protection.record(ip, username, false);
		rt.audit.log({ username, action: 'auth.login.fail', detail: 'passkey', ip });
		return apiError(401, GENERIC);
	};

	if (!raw || typeof raw.id !== 'string') return fail();
	const challenge = clientDataChallenge(raw.response?.clientDataJSON);
	if (!challenge) return fail();
	const response = raw as unknown as AuthenticationResponseJSON;
	const pending = rt.passkeys.peekChallenge(challenge, 'login');
	if (!pending) return fail();
	const cred = rt.passkeys.byCredentialId(response.id);
	if (!cred) return fail();
	// A challenge issued for a named account may only complete for that
	// account's own credentials.
	if (pending.userId !== null && pending.userId !== cred.userId) return fail();
	const user = rt.users.byId(cred.userId);
	if (!user) return fail();
	if (user.disabledAt !== null) {
		rt.audit.log({
			userId: user.id,
			username: user.username,
			action: 'auth.login.disabled',
			ip
		});
		return fail(user.username);
	}
	// Same progressive delay the password path pays when an account is
	// under distributed attack.
	const delay = rt.protection.usernameDelayMs(user.username, policy);
	if (delay > 0) await new Promise((r) => setTimeout(r, delay));

	const { rpID, origin } = relyingParty(rt.config, event.url);
	let verification;
	try {
		verification = await verifyAuthenticationResponse({
			response,
			expectedChallenge: challenge,
			expectedOrigin: origin,
			expectedRPID: rpID,
			credential: {
				id: cred.credentialId,
				publicKey: new Uint8Array(cred.publicKey),
				counter: cred.counter,
				transports: cred.transports
			},
			requireUserVerification: false
		});
	} catch {
		return fail(user.username);
	}
	if (!verification.verified) return fail(user.username);

	// The passkey replaces the password factor only; a TOTP-enabled
	// account still owes its second factor, same as the password path.
	// The challenge stays claimable until it is consumed below, so a
	// totp_required retry replays the same assertion plus the code.
	if (user.totpEnabled) {
		if (!code) return apiJson({ totp_required: true });
		const row = rt.users.rowById(user.id);
		const secret = row ? rt.users.totpSecret(row) : null;
		let ok = secret ? verifyTotp(secret, code) : false;
		if (!ok && row) ok = rt.users.consumeBackupCode(row.id, hashToken(code));
		if (!ok) return fail(user.username);
	}

	// A sign counter that failed to advance flags a cloned
	// authenticator; recordUse deletes the credential and the login
	// is refused.
	const info = verification.authenticationInfo;
	const outcome = rt.passkeys.recordUse(cred.id, info.newCounter, info.credentialBackedUp);
	if (outcome === 'cloned') {
		rt.audit.log({
			userId: user.id,
			username: user.username,
			action: 'account.passkey.cloned',
			detail: cred.name || null,
			ip
		});
		rt.protection.record(ip, user.username, false);
		return apiError(401, GENERIC);
	}
	if (outcome === 'missing') return fail(user.username);
	if (!rt.passkeys.consumeChallenge(challenge, 'login')) return fail(user.username);

	rt.protection.record(ip, user.username, true);
	rt.users.touchLogin(user.id);
	const token = rt.sessions.create(
		user.id,
		rt.sessionTtlMs(),
		ip,
		event.request.headers.get('user-agent')
	);
	setSessionCookie(event.cookies, token, rt.sessionTtlMs(), isSecureRequest(event));
	rt.audit.log({
		userId: user.id,
		username: user.username,
		action: 'auth.login',
		detail: 'passkey',
		ip
	});
	return apiJson({ ok: true, user });
};
