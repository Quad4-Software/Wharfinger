import { generateRegistrationOptions } from '@simplewebauthn/server';
import type { AuthenticatorTransport } from '@simplewebauthn/server';
import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { relyingParty } from '$lib/server/admin/webauthn';
import { apiJson, requireUser } from '$lib/server/admin/http';
import { WEBAUTHN_CHALLENGE_TTL_MS } from '$lib/server/constants';

/**
 * Step 1 of passkey enrollment: creation options with a single-use
 * challenge bound to the caller. Existing credentials are excluded so
 * the same authenticator cannot be registered twice.
 */
export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const user = requireUser(event);
	const { rpID, rpName } = relyingParty(rt.config, event.url);
	const options = await generateRegistrationOptions({
		rpName,
		rpID,
		userName: user.username,
		userDisplayName: user.displayName || user.username,
		attestationType: 'none',
		excludeCredentials: (await rt.passkeys.forUser(user.id)).map((c) => ({
			id: c.credentialId,
			transports: c.transports as AuthenticatorTransport[]
		})),
		authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' }
	});
	await rt.passkeys.putChallenge(options.challenge, 'register', user.id, WEBAUTHN_CHALLENGE_TTL_MS);
	return apiJson(options);
};
