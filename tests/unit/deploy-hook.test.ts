import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	branchMatches,
	hookSignatureOk,
	isPRWebhook,
	parsePREvent,
	parsePush,
	pathsMatch,
	prHeadRef
} from '$lib/server/deploy/hook';

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
		expect(parsePush(BODY)).toEqual({ ref: 'refs/heads/main', commit: 'abc123', paths: [] });
	});
	it('reads gitlab-style checkout_sha', () => {
		expect(parsePush('{"ref":"refs/heads/dev","checkout_sha":"deadbeef"}')).toEqual({
			ref: 'refs/heads/dev',
			commit: 'deadbeef',
			paths: []
		});
	});
	it('collects touched paths from commits and head_commit', () => {
		const r = parsePush(
			JSON.stringify({
				after: 'abc',
				commits: [{ added: ['a.ts', 'b.ts'], modified: ['c.ts'] }],
				head_commit: { removed: ['d.ts'], modified: ['c.ts'] }
			})
		);
		expect(r?.paths.sort()).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
	});
	it('truncates oversized commit values', () => {
		const r = parsePush(`{"after":"${'a'.repeat(200)}"}`);
		expect(r?.commit).toHaveLength(64);
	});
	it('returns null for non-JSON bodies', () => {
		expect(parsePush('not json')).toBeNull();
	});
});

describe('pathsMatch', () => {
	const touched = ['apps/web/src/main.ts', 'docs/readme.md'];
	it('matches exact paths and directory prefixes', () => {
		expect(pathsMatch(['apps/web'], touched)).toBe(true);
		expect(pathsMatch(['apps/web/src/main.ts'], touched)).toBe(true);
		expect(pathsMatch(['apps/api'], touched)).toBe(false);
	});
	it('handles * and ** globs', () => {
		expect(pathsMatch(['apps/*/src/**'], touched)).toBe(true);
		expect(pathsMatch(['apps/**/main.ts'], touched)).toBe(true);
		expect(pathsMatch(['**/readme.md'], touched)).toBe(true);
		expect(pathsMatch(['apps/**'], touched)).toBe(true);
		expect(pathsMatch(['ops/**'], touched)).toBe(false);
	});
	it('deploys always when the event carries no paths', () => {
		expect(pathsMatch(['apps/api'], [])).toBe(true);
	});
});

describe('parsePREvent', () => {
	const ghBody = (action: string, extra = '') =>
		`{"action":"${action}","number":42,"pull_request":{"number":42,"head":{"sha":"headsha123","ref":"feature"}}${extra}}`;

	it('parses github pull_request update actions', () => {
		for (const action of ['opened', 'reopened', 'synchronize']) {
			const ev = parsePREvent(headers({ 'x-github-event': 'pull_request' }), ghBody(action));
			expect(ev).toEqual({ action: 'update', pr: 42, sha: 'headsha123' });
		}
	});

	it('parses github pull_request closed as a close event', () => {
		const ev = parsePREvent(
			headers({ 'x-github-event': 'pull_request' }),
			ghBody('closed', ',"merged":true')
		);
		expect(ev).toEqual({ action: 'close', pr: 42, sha: 'headsha123' });
	});

	it('accepts gitea and forgejo event headers', () => {
		for (const h of ['x-gitea-event', 'x-forgejo-event']) {
			const ev = parsePREvent(headers({ [h]: 'pull_request' }), ghBody('opened'));
			expect(ev?.action).toBe('update');
		}
	});

	it('parses gitlab merge request hooks', () => {
		const open = parsePREvent(
			headers({ 'x-gitlab-event': 'Merge Request Hook' }),
			JSON.stringify({
				object_kind: 'merge_request',
				object_attributes: { iid: 7, action: 'update', last_commit: { id: 'mrsha' } }
			})
		);
		expect(open).toEqual({ action: 'update', pr: 7, sha: 'mrsha' });
		const merge = parsePREvent(
			headers({ 'x-gitlab-event': 'Merge Request Hook' }),
			JSON.stringify({
				object_kind: 'merge_request',
				object_attributes: { iid: 7, action: 'merge' }
			})
		);
		expect(merge).toEqual({ action: 'close', pr: 7, sha: null });
	});

	it('ignores non-PR events and bad payloads', () => {
		expect(parsePREvent(headers({ 'x-github-event': 'push' }), ghBody('opened'))).toBeNull();
		expect(parsePREvent(headers({}), ghBody('opened'))).toBeNull();
		expect(parsePREvent(headers({ 'x-github-event': 'pull_request' }), 'not json')).toBeNull();
		expect(
			parsePREvent(headers({ 'x-github-event': 'pull_request' }), '{"action":"opened","number":0}')
		).toBeNull();
		expect(
			parsePREvent(
				headers({ 'x-github-event': 'pull_request' }),
				'{"action":"labeled","number":5,"pull_request":{"number":5}}'
			)
		).toBeNull();
		expect(
			parsePREvent(
				headers({ 'x-gitlab-event': 'Merge Request Hook' }),
				'{"object_kind":"push","object_attributes":{"iid":3,"action":"open"}}'
			)
		).toBeNull();
	});

	it('isPRWebhook marks even unhandled actions as PR events', () => {
		// The route relies on this: an 'edited' or 'labeled' PR event
		// must not fall through to push parsing, where a refless body
		// would deploy the app's configured branch.
		expect(isPRWebhook(headers({ 'x-github-event': 'pull_request' }))).toBe(true);
		expect(isPRWebhook(headers({ 'x-gitlab-event': 'Merge Request Hook' }))).toBe(true);
		expect(isPRWebhook(headers({ 'x-github-event': 'push' }))).toBe(false);
		expect(isPRWebhook(headers({}))).toBe(false);
	});
});

describe('prHeadRef', () => {
	it('maps forges to their PR head refs', () => {
		expect(prHeadRef('github', 42)).toBe('refs/pull/42/head');
		expect(prHeadRef('gitea', 42)).toBe('refs/pull/42/head');
		expect(prHeadRef('gitlab', 42)).toBe('refs/merge-requests/42/head');
		expect(prHeadRef(undefined, 42)).toBe('refs/pull/42/head');
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
