import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { branchMatches, hookSignatureOk, parsePush } from '$lib/server/deploy/hook';

function headers(entries: Record<string, string>): Headers {
	return new Headers(entries);
}

const BODY = '{"ref":"refs/heads/main","after":"abc123"}';
const SECRET = 'hook-secret-value';

describe('hookSignatureOk', () => {
	it('accepts a valid GitHub sha256 signature', () => {
		const sig = `sha256=${createHmac('sha256', SECRET).update(BODY).digest('hex')}`;
		expect(hookSignatureOk(headers({ 'x-hub-signature-256': sig }), BODY, SECRET)).toBe(true);
	});

	it('rejects a signature over a different body', () => {
		const sig = `sha256=${createHmac('sha256', SECRET).update(BODY).digest('hex')}`;
		expect(hookSignatureOk(headers({ 'x-hub-signature-256': sig }), 'tampered', SECRET)).toBe(
			false
		);
	});

	it('rejects a signature with the wrong secret', () => {
		const sig = `sha256=${createHmac('sha256', 'wrong').update(BODY).digest('hex')}`;
		expect(hookSignatureOk(headers({ 'x-hub-signature-256': sig }), BODY, SECRET)).toBe(false);
	});

	it('accepts a valid GitLab token', () => {
		expect(hookSignatureOk(headers({ 'x-gitlab-token': SECRET }), BODY, SECRET)).toBe(true);
	});

	it('rejects a wrong GitLab token', () => {
		expect(hookSignatureOk(headers({ 'x-gitlab-token': 'nope' }), BODY, SECRET)).toBe(false);
	});

	it('accepts a custom-forge shared secret header', () => {
		expect(hookSignatureOk(headers({ 'x-wharfinger-secret': SECRET }), BODY, SECRET)).toBe(true);
	});

	it('rejects when no signature headers are present', () => {
		expect(hookSignatureOk(headers({}), BODY, SECRET)).toBe(false);
	});
});

describe('parsePush', () => {
	it('reads github-style ref and after', () => {
		expect(parsePush(BODY)).toEqual({ ref: 'refs/heads/main', commit: 'abc123' });
	});
	it('reads gitlab-style checkout_sha', () => {
		expect(parsePush('{"ref":"refs/heads/dev","checkout_sha":"deadbeef"}')).toEqual({
			ref: 'refs/heads/dev',
			commit: 'deadbeef'
		});
	});
	it('truncates oversized commit values', () => {
		const r = parsePush(`{"after":"${'a'.repeat(200)}"}`);
		expect(r?.commit).toHaveLength(64);
	});
	it('returns null for non-JSON bodies', () => {
		expect(parsePush('not json')).toBeNull();
	});
});

describe('branchMatches', () => {
	it('matches the configured branch', () => {
		expect(branchMatches('refs/heads/main', 'main')).toBe(true);
		expect(branchMatches('refs/heads/dev', 'main')).toBe(false);
	});
	it('non-push refs and empty refs always pass', () => {
		expect(branchMatches('refs/tags/v1', 'main')).toBe(true);
		expect(branchMatches('', 'main')).toBe(true);
	});
});
