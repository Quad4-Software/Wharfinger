import { describe, expect, it, vi } from 'vitest';
import {
	forgeKind,
	listBranches,
	parseRepoCoords,
	postCommitStatus,
	statusRequest
} from '$lib/server/deploy/forge';
import { makeEgress } from '$lib/server/http/egress';

describe('parseRepoCoords', () => {
	it('parses https and scp-style urls', () => {
		expect(parseRepoCoords('https://github.com/quad4/wharfinger.git')).toEqual({
			host: 'github.com',
			owner: 'quad4',
			repo: 'wharfinger'
		});
		expect(parseRepoCoords('git@gitlab.example.com:team/sub/app.git')).toEqual({
			host: 'gitlab.example.com',
			owner: 'team/sub',
			repo: 'app'
		});
	});
	it('rejects non-repo urls', () => {
		expect(parseRepoCoords('https://github.com/justuser')).toBeNull();
		expect(parseRepoCoords('file:///tmp/repo')).toBeNull();
	});
});

describe('forgeKind', () => {
	const gh = { host: 'github.com', owner: 'o', repo: 'r' };
	it('detects by hostname', () => {
		expect(forgeKind(undefined, gh)).toBe('github');
		expect(forgeKind(undefined, { ...gh, host: 'gitlab.com' })).toBe('gitlab');
		expect(forgeKind(undefined, { ...gh, host: 'gitea.internal' })).toBe('gitea');
		expect(forgeKind(undefined, { ...gh, host: 'git.acme.test' })).toBe('generic');
	});
	it('explicit override wins for self-hosted instances', () => {
		expect(forgeKind('gitlab', { ...gh, host: 'git.acme.test' })).toBe('gitlab');
		expect(forgeKind('bogus', gh)).toBe('github');
	});
});

describe('statusRequest', () => {
	const gh = { host: 'github.com', owner: 'o', repo: 'r' };
	const sha = 'deadbeef'.repeat(5);
	const opts = { description: 'd', targetUrl: 'https://app.example.com' };

	it('builds a github commit status', () => {
		const r = statusRequest('github', gh, sha, 'live', opts);
		expect(r?.url).toBe(`https://api.github.com/repos/o/r/statuses/${sha}`);
		expect(r?.auth).toBe('bearer');
		expect(r?.body.state).toBe('success');
		expect(r?.body.target_url).toBe('https://app.example.com');
	});
	it('maps statuses per forge', () => {
		expect(statusRequest('github', gh, sha, 'pending', opts)?.body.state).toBe('pending');
		expect(statusRequest('github', gh, sha, 'rolled_back', opts)?.body.state).toBe('failure');
		expect(
			statusRequest('gitlab', { ...gh, host: 'gitlab.com' }, sha, 'rolled_back', opts)?.body.state
		).toBe('canceled');
		expect(statusRequest('github', gh, sha, 'superseded', opts)).toBeNull();
	});
	it('uses the gitea api shape on self-hosted hosts', () => {
		const r = statusRequest(
			'gitea',
			{ host: 'gitea.acme.test', owner: 'o', repo: 'r' },
			sha,
			'live',
			opts
		);
		expect(r?.url).toBe(`https://gitea.acme.test/api/v1/repos/o/r/statuses/${sha}`);
	});
	it('gitlab encodes the project path and uses private-token auth', () => {
		const r = statusRequest('gitlab', { ...gh, host: 'gitlab.com' }, sha, 'failed', opts);
		expect(r?.url).toBe(`https://gitlab.com/api/v4/projects/o%2Fr/statuses/${sha}`);
		expect(r?.auth).toBe('job-token');
	});
	it('generic forges have no status api', () => {
		expect(statusRequest('generic', gh, sha, 'live', opts)).toBeNull();
	});
});

describe('postCommitStatus', () => {
	const egress = makeEgress(() => false);
	const gh = { host: 'github.com', owner: 'o', repo: 'r' };
	const sha = 'deadbeef'.repeat(5);
	const opts = { description: 'd', targetUrl: null };

	it('refuses non-sha refs before they reach a url', async () => {
		const r = await postCommitStatus(egress, 'github', gh, 'tok', 'main; rm -rf', 'live', opts);
		expect(r.ok).toBe(false);
	});

	it('posts bearer auth to the github api', async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		vi.stubGlobal('fetch', (url: string | URL | Request, init: RequestInit) => {
			calls.push({ url: url instanceof Request ? url.url : String(url), init });
			return Promise.resolve(new Response('', { status: 201 }));
		});
		try {
			const r = await postCommitStatus(egress, 'github', gh, 'tok', sha, 'live', opts);
			expect(r.ok).toBe(true);
			expect(calls[0].url).toContain('api.github.com');
			expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer tok');
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('reports non-2xx without throwing', async () => {
		vi.stubGlobal('fetch', () => Promise.resolve(new Response('', { status: 403 })));
		try {
			const r = await postCommitStatus(egress, 'github', gh, 'tok', sha, 'live', opts);
			expect(r).toEqual({ ok: false, error: 'HTTP 403' });
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe('listBranches', () => {
	const egress = makeEgress(() => false);
	const gh = { host: 'github.com', owner: 'o', repo: 'r' };

	it('lists branch names with bearer auth', async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		vi.stubGlobal('fetch', (url: string | URL | Request, init: RequestInit) => {
			calls.push({ url: url instanceof Request ? url.url : String(url), init });
			return Promise.resolve(
				new Response(JSON.stringify([{ name: 'main' }, { name: 'dev' }, { nope: 1 }]), {
					status: 200
				})
			);
		});
		try {
			const r = await listBranches(egress, 'github', gh, 'tok');
			expect(r).toEqual({ ok: true, branches: ['main', 'dev'], error: null });
			expect(calls[0].url).toBe('https://api.github.com/repos/o/r/branches?per_page=100');
			expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer tok');
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('caps the list at 100 names and drops overlong ones', async () => {
		const many = Array.from({ length: 130 }, (_, i) => ({ name: `b${i}` }));
		many.push({ name: 'x'.repeat(201) });
		vi.stubGlobal('fetch', () =>
			Promise.resolve(new Response(JSON.stringify(many), { status: 200 }))
		);
		try {
			const r = await listBranches(egress, 'github', gh, null);
			expect(r.ok).toBe(true);
			expect(r.branches).toHaveLength(100);
			expect(r.branches.every((b) => b.length <= 200)).toBe(true);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('generic forges report an unsupported error', async () => {
		const r = await listBranches(egress, 'generic', gh, null);
		expect(r.ok).toBe(false);
		expect(r.error).toContain('no branch api');
	});
});
