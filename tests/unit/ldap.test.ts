import { beforeEach, describe, expect, it, vi } from 'vitest';

// ldapAuthenticate is exercised against a stubbed ldapts Client: the
// real BER wire protocol needs a directory server, which e2e cannot
// reasonably host. What matters here is the flow: bind with an
// escaped DN, optional service search, group-to-role mapping, and
// collapsing every failure to null.

const state = vi.hoisted(() => ({
	bind: vi.fn(),
	search: vi.fn(),
	startTLS: vi.fn(),
	unbind: vi.fn(),
	lastClient: null as { url?: string } | null
}));

vi.mock('ldapts', () => ({
	Client: class {
		url: string;
		constructor(opts: { url: string }) {
			this.url = opts.url;
			state.lastClient = this;
		}
		bind = state.bind;
		search = state.search;
		startTLS = state.startTLS;
		unbind = state.unbind;
	}
}));

import { ldapAuthenticate } from '$lib/server/admin/ldap';

const cfg = {
	enabled: true,
	url: 'ldap://directory.internal:389',
	starttls: false,
	bind_dn: 'uid={username},ou=people,dc=example,dc=com',
	search_bind_dn: '',
	search_bind_password: '',
	search_base: 'ou=people,dc=example,dc=com',
	user_filter: '(uid={username})',
	display_attr: 'cn',
	admin_group: 'cn=admins,ou=groups,dc=example,dc=com',
	operator_group: '',
	default_role: 'deny' as const,
	timeout_ms: 5000
};

beforeEach(() => {
	vi.clearAllMocks();
	state.bind.mockResolvedValue(undefined);
	state.startTLS.mockResolvedValue(undefined);
	state.unbind.mockResolvedValue(undefined);
	state.search.mockResolvedValue({
		searchEntries: [
			{
				cn: 'Alice Example',
				memberOf: ['cn=admins,ou=groups,dc=example,dc=com']
			}
		]
	});
});

describe('ldapAuthenticate', () => {
	it('binds, searches, and maps the admin group', async () => {
		const ident = await ldapAuthenticate(cfg, 'alice', 'pw');
		expect(state.bind).toHaveBeenCalledWith('uid=alice,ou=people,dc=example,dc=com', 'pw');
		expect(ident?.role).toBe('admin');
		expect(ident?.displayName).toBe('Alice Example');
	});

	it('escapes DN metacharacters in the bind DN', async () => {
		await ldapAuthenticate(cfg, 'a,b+c', 'pw');
		expect(state.bind).toHaveBeenCalledWith('uid=a\\,b\\+c,ou=people,dc=example,dc=com', 'pw');
	});

	it('escapes filter metacharacters in the user filter', async () => {
		await ldapAuthenticate(cfg, 'a)(uid=*', 'pw');
		const [, opts] = state.search.mock.calls[0] as unknown as [string, { filter: string }];
		expect(opts.filter).toBe('(uid=a\\29\\28uid=\\2a)');
	});

	it('returns null on bad credentials', async () => {
		state.bind.mockRejectedValue(new Error('invalid credentials'));
		expect(await ldapAuthenticate(cfg, 'alice', 'wrong')).toBeNull();
	});

	it('returns null for users with no role-mapped group', async () => {
		state.search.mockResolvedValue({ searchEntries: [{ cn: 'Bob', memberOf: [] }] });
		const ident = await ldapAuthenticate(cfg, 'bob', 'pw');
		expect(ident?.role).toBeNull();
	});

	it('collapses connection failures to null', async () => {
		state.bind.mockRejectedValue(new Error('ECONNREFUSED'));
		expect(await ldapAuthenticate(cfg, 'alice', 'pw')).toBeNull();
	});

	it('skips work entirely when disabled or password is empty', async () => {
		expect(await ldapAuthenticate({ ...cfg, enabled: false }, 'a', 'pw')).toBeNull();
		expect(await ldapAuthenticate(cfg, 'a', '')).toBeNull();
		expect(state.bind).not.toHaveBeenCalled();
	});
});
