import { describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { RequestEvent } from '@sveltejs/kit';
import type { Runtime } from '$lib/server/runtime';
import type { Permission } from '$lib/server/admin/authz';
import type { User } from '$lib/server/admin/users';
import { TeamError } from '$lib/server/teams/store';

const ref = vi.hoisted(() => ({
	db: undefined as unknown as DatabaseSync,
	rt: undefined as unknown as Runtime
}));

vi.mock('$lib/server/runtime', async () => {
	process.env.WHARFINGER_SECRET_KEY = 'teams-test-key-material';
	const { mkdtempSync } = await import('node:fs');
	const { join } = await import('node:path');
	const { tmpdir } = await import('node:os');
	const dir = mkdtempSync(join(tmpdir(), 'q4s-teams-'));
	const { openDb } = await import('$lib/server/store/db');
	const { AuditStore } = await import('$lib/server/admin/audit');
	const { UserStore } = await import('$lib/server/admin/users');
	const db = openDb(dir);
	ref.db = db;
	ref.rt = {
		db,
		users: new UserStore(db),
		audit: new AuditStore(db)
	} as unknown as Runtime;
	return { getRuntime: () => ref.rt };
});

const { getTeamStore } = await import('$lib/server/teams/store');
const { getGroupStore } = await import('$lib/server/groups/store');
const { GET: listTeams, POST: createTeam } =
	await import('../../src/routes/admin/api/teams/+server');
const { PATCH: patchTeam, DELETE: deleteTeam } =
	await import('../../src/routes/admin/api/teams/[id]/+server');
const { PUT: putMembers } = await import('../../src/routes/admin/api/teams/[id]/members/+server');
const { PUT: putGroups } = await import('../../src/routes/admin/api/teams/[id]/groups/+server');
const { GET: mineTeams } = await import('../../src/routes/admin/api/teams/mine/+server');

const admin: User = {
	id: 1,
	username: 'root',
	displayName: '',
	role: 'admin',
	totpEnabled: false,
	createdAt: 0,
	disabledAt: null,
	lastLoginAt: null
};

function event(opts: {
	method?: string;
	path?: string;
	body?: unknown;
	params?: Record<string, string>;
	user?: User | null;
	perms?: Permission[];
}): RequestEvent {
	const path = opts.path ?? '/admin/api/teams';
	return {
		locals: {
			user: opts.user === undefined ? admin : opts.user,
			perms: new Set(opts.perms ?? ['teams.manage'])
		},
		params: opts.params ?? {},
		url: new URL(`http://test${path}`),
		request: new Request(`http://test${path}`, {
			method: opts.method ?? 'GET',
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
		}),
		getClientAddress: () => '127.0.0.1'
	} as unknown as RequestEvent;
}

async function status(fn: (e: never) => unknown, ev: RequestEvent): Promise<number> {
	try {
		const res = await fn(ev as never);
		return (res as Response).status;
	} catch (e) {
		const s = (e as { status?: unknown }).status;
		return typeof s === 'number' ? s : 0;
	}
}

async function json(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

function seedUser(username: string): number {
	return ref.rt.users.create(username, 'a-very-long-password', 'viewer').id;
}

describe('TeamStore', () => {
	it('creates, lists, updates, and removes teams', () => {
		const store = getTeamStore(ref.db);
		const t = store.create('On Call');
		expect(t.id).toMatch(/^team_/);
		expect(store.get(t.id)?.name).toBe('On Call');
		expect(store.list().map((x) => x.name)).toContain('On Call');

		expect(store.update(t.id, 'Oncall')?.name).toBe('Oncall');
		expect(store.update('team_none', 'x')).toBeNull();
		expect(store.remove(t.id)).toBe(true);
		expect(store.remove(t.id)).toBe(false);
	});

	it('rejects bad names and duplicate names', () => {
		const store = getTeamStore(ref.db);
		expect(() => store.create('')).toThrow(TeamError);
		expect(() => store.create('x'.repeat(65))).toThrow(TeamError);
		store.create('dup');
		try {
			store.create('dup');
			expect.unreachable();
		} catch (e) {
			expect((e as TeamError).status).toBe(409);
		}
	});

	it('dedupes members and requires existing users', () => {
		const store = getTeamStore(ref.db);
		const uid = seedUser('eve');
		const t = store.create('members');
		const once = store.setMembers(t.id, [uid], []);
		expect(once.members).toHaveLength(1);
		expect(once.members[0].username).toBe('eve');
		const twice = store.setMembers(t.id, [uid, uid], []);
		expect(twice.members).toHaveLength(1);
		expect(() => store.setMembers(t.id, [99999], [])).toThrow(TeamError);
		const after = store.setMembers(t.id, [], [uid]);
		expect(after.members).toHaveLength(0);
	});

	it('assigns groups that must exist', () => {
		const store = getTeamStore(ref.db);
		const groupStore = getGroupStore(ref.db);
		const g = groupStore.create('team-scope');
		const t = store.create('scoped');
		const withGroup = store.setGroups(t.id, [g.id]);
		expect(withGroup.groups.map((x) => x.id)).toEqual([g.id]);
		expect(() => store.setGroups(t.id, ['grp_missing'])).toThrow(TeamError);
		expect(store.setGroups(t.id, []).groups).toHaveLength(0);
	});

	it('cascades member and group rows on delete', () => {
		const store = getTeamStore(ref.db);
		const uid = seedUser('fred');
		const t = store.create('cascade');
		store.setMembers(t.id, [uid], []);
		store.remove(t.id);
		const members = ref.db
			.prepare('SELECT COUNT(*) AS n FROM team_members WHERE team_id = ?')
			.get(t.id) as { n: number };
		expect(members.n).toBe(0);
	});

	it('returns only the caller teams for the mine endpoint', async () => {
		const store = getTeamStore(ref.db);
		const uid = seedUser('gina');
		const mine = store.create('mine-team');
		const other = store.create('other-team');
		store.setMembers(mine.id, [uid], []);

		const caller = { ...admin, id: uid };
		const res = await json(await mineTeams(event({ user: caller }) as never));
		const teams = res.teams as { id: string }[];
		expect(teams.map((t) => t.id)).toEqual([mine.id]);
		expect(teams.map((t) => t.id)).not.toContain(other.id);
	});

	it('mine rejects anonymous callers with 401', async () => {
		expect(await status(mineTeams, event({ user: null, path: '/admin/api/teams/mine' }))).toBe(401);
	});
});

describe('team routes', () => {
	it('rejects anonymous callers with 401', async () => {
		expect(await status(listTeams, event({ user: null }))).toBe(401);
	});

	it('rejects users without teams.manage with 403', async () => {
		expect(await status(listTeams, event({ perms: [] }))).toBe(403);
		expect(await status(listTeams, event({ perms: ['status.view'] }))).toBe(403);
	});

	it('creates a team and audits it', async () => {
		const res = await json(
			await createTeam(event({ method: 'POST', body: { name: 'api-team' } }) as never)
		);
		expect(res.ok).toBe(true);
		const row = ref.db
			.prepare(
				"SELECT action, detail FROM audit_log WHERE action = 'team.create' ORDER BY id DESC LIMIT 1"
			)
			.get() as { action: string; detail: string };
		expect(row.detail).toContain('api-team');
	});

	it('supports the members and groups routes end to end', async () => {
		const uid = seedUser('hank');
		const g = getGroupStore(ref.db).create('route-scope');
		const created = await json(
			await createTeam(event({ method: 'POST', body: { name: 'route-team' } }) as never)
		);
		const id = (created.team as { id: string }).id;

		const withMember = await json(
			await putMembers(
				event({ method: 'PUT', params: { id }, body: { add: [uid], remove: [] } }) as never
			)
		);
		expect((withMember.team as { members: unknown[] }).members).toHaveLength(1);

		const withGroup = await json(
			await putGroups(event({ method: 'PUT', params: { id }, body: { groupIds: [g.id] } }) as never)
		);
		expect((withGroup.team as { groups: { id: string }[] }).groups[0].id).toBe(g.id);

		expect(
			await status(putGroups, event({ method: 'PUT', params: { id }, body: { groupIds: 'nope' } }))
		).toBe(422);
		expect(
			await status(
				putMembers,
				event({ method: 'PUT', params: { id }, body: { add: ['not-a-number'] } })
			)
		).toBe(422);
		expect(await status(deleteTeam, event({ method: 'DELETE', params: { id } }))).toBe(200);
		expect(
			await status(patchTeam, event({ method: 'PATCH', params: { id }, body: { name: 'x' } }))
		).toBe(404);
	});
});
