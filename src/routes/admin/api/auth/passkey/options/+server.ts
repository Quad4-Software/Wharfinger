import { generateAuthenticationOptions } from '@simplewebauthn/server';
import type { AuthenticatorTransportFuture } from '@simplewebauthn/server';
import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { relyingParty } from '$lib/server/admin/webauthn';
import { apiJson, readJson } from '$lib/server/admin/http';
import { WEBAUTHN_CHALLENGE_TTL_MS } from '$lib/server/constants';

/**
 * Step 1 of passkey sign-in. An optional username narrows the ceremony
 * to that account's credentials and binds the challenge to the user;
 * without one the discoverable (resident key) flow runs and the
 * returned credential decides the account. Unknown or disabled
 * usernames fall back to the same discoverable options so responses
 * do not reveal which accounts exist or hold passkeys.
 */
export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const body = await readJson<{ username?: unknown }>(event.request, 8192);
	const username = typeof body.username === 'string' ? body.username.slice(0, 128) : '';

	const { rpID } = relyingParty(rt.config, event.url);
	let userId: number | null = null;
	let allowCredentials: { id: string; transports?: AuthenticatorTransportFuture[] }[] | undefined;
	if (username) {
		const row = rt.users.rowByName(username);
		if (row?.disabled_at === null) {
			userId = row.id;
			allowCredentials = rt.passkeys.forUser(row.id).map((c) => ({
				id: c.credentialId,
				transports: c.transports as AuthenticatorTransportFuture[]
			}));
		}
	}
	const options = await generateAuthenticationOptions({
		rpID,
		allowCredentials,
		userVerification: 'preferred'
	});
	rt.passkeys.putChallenge(options.challenge, 'login', userId, WEBAUTHN_CHALLENGE_TTL_MS);
	return apiJson(options);
};
