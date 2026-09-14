import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify a provider signature over a raw webhook body. Three styles
 * are accepted: GitHub X-Hub-Signature-256 (HMAC over the body),
 * GitLab X-Gitlab-Token (shared token), and X-Quad4-Secret (shared
 * token for custom forges). All comparisons are constant-time and
 * length-checked first so mismatched inputs never reach the compare.
 */
export function hookSignatureOk(headers: Headers, body: string, secret: string): boolean {
	const gh = headers.get('x-hub-signature-256') ?? '';
	const gl = headers.get('x-gitlab-token') ?? '';
	const plain = headers.get('x-wharfinger-secret') ?? '';
	const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
	return (
		(gh.length === expected.length && timingSafeEqual(Buffer.from(gh), Buffer.from(expected))) ||
		(gl.length === secret.length && timingSafeEqual(Buffer.from(gl), Buffer.from(secret))) ||
		(plain.length === secret.length && timingSafeEqual(Buffer.from(plain), Buffer.from(secret)))
	);
}

/** Parse a push payload: ref and head commit across forge shapes. */
export function parsePush(text: string): { ref: string; commit: string | null } | null {
	let payload: { ref?: unknown; checkout_sha?: unknown; after?: unknown };
	try {
		payload = JSON.parse(text) as typeof payload;
	} catch {
		return null;
	}
	const ref = typeof payload.ref === 'string' ? payload.ref : '';
	const commit =
		typeof payload.after === 'string'
			? payload.after.slice(0, 64)
			: typeof payload.checkout_sha === 'string'
				? payload.checkout_sha.slice(0, 64)
				: null;
	return { ref, commit };
}

/** True when the push targets the app's configured branch. */
export function branchMatches(ref: string, want: string): boolean {
	if (!ref.startsWith('refs/heads/')) return true;
	return ref.slice('refs/heads/'.length) === want;
}
