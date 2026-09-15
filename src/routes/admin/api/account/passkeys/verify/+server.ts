import { verifyRegistrationResponse } from '@simplewebauthn/server';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { clientDataChallenge, passkeyInfo, relyingParty } from '$lib/server/admin/webauthn';
import { apiError, apiJson, asString, audit, readJson, requireUser } from '$lib/server/admin/http';

const CEREMONY_EXPIRED = 'passkey ceremony expired; try again';

/**
 * Step 2 of passkey enrollment: verify the attestation against the
 * stored challenge, then persist the credential. The challenge is
 * consumed atomically so a response cannot be replayed.
 */
export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const user = requireUser(event);
	const body = await readJson<{ name?: unknown; response?: unknown }>(event.request, 16 * 1024);
	// Validate through a deep-optional view before trusting the shape;
	// the full type is asserted only once the nested fields exist.
	const raw = body.response as
		{ id?: unknown; response?: { clientDataJSON?: unknown } } | undefined;
	if (!raw || typeof raw.id !== 'string') return apiError(422, 'malformed passkey response');
	const challenge = clientDataChallenge(raw.response?.clientDataJSON);
	if (!challenge) return apiError(422, 'malformed passkey response');
	const response = raw as unknown as RegistrationResponseJSON;
	const pending = await rt.passkeys.peekChallenge(challenge, 'register');
	if (pending?.userId !== user.id) return apiError(422, CEREMONY_EXPIRED);

	const { rpID, origin } = relyingParty(rt.config, event.url);
	let verification;
	try {
		verification = await verifyRegistrationResponse({
			response,
			expectedChallenge: challenge,
			expectedOrigin: origin,
			expectedRPID: rpID,
			requireUserVerification: false
		});
	} catch {
		return apiError(422, 'passkey verification failed');
	}
	if (!verification.verified) return apiError(422, 'passkey verification failed');

	if (!(await rt.passkeys.consumeChallenge(challenge, 'register'))) {
		return apiError(422, CEREMONY_EXPIRED);
	}
	const info = verification.registrationInfo;
	const name = asString(body.name, 80) ?? 'Passkey';
	const created = await rt.passkeys.insert({
		userId: user.id,
		credentialId: info.credential.id,
		publicKey: info.credential.publicKey,
		counter: info.credential.counter,
		transports: info.credential.transports ?? [],
		name,
		backedUp: info.credentialBackedUp
	});
	if (!created) return apiError(409, 'this passkey is already registered');
	await audit(rt, event, 'account.passkey.add', name);
	return apiJson({ ok: true, passkey: passkeyInfo(created) });
};
