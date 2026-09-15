import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { asDb, isUniqueViolation, rawSqlite, type Db } from '$lib/server/store/driver';
import type { GroupRef, TeamInfo, TeamMember } from '$lib/shared/groups';

export class TeamError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}
}

const NAME_MAX = 64;
const MAX_MEMBERS = 500;
const MAX_GROUPS = 200;

interface TeamRow {
	id: string;
	name: string;
	created_at: number;
}

interface UserRow {
	id: number;
	username: string;
	display_name: string;
}

function validName(name: string): string {
	const n = name.trim();
	if (n.length < 1 || n.length > NAME_MAX) {
		throw new TeamError(422, 'name must be 1-64 characters');
	}
	return n;
}

function inMarks(n: number): string {
	return Array.from({ length: n }, () => '?').join(',');
}

export class TeamStore {
	private readonly db: Db;

	constructor(db: Db | DatabaseSync) {
		this.db = asDb(db);
		// Lazy DDL is sqlite-only; surreal gets these tables from
		// store/schema.ts.
		rawSqlite(this.db)?.exec(`
			CREATE TABLE IF NOT EXISTS teams (
				id         TEXT PRIMARY KEY,
				name       TEXT NOT NULL UNIQUE,
				created_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS team_members (
				team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
				user_id INTEGER NOT NULL,
				PRIMARY KEY (team_id, user_id)
			);
			CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members (user_id);
			CREATE TABLE IF NOT EXISTS team_groups (
				team_id  TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
				group_id TEXT NOT NULL REFERENCES service_groups(id) ON DELETE CASCADE,
				PRIMARY KEY (team_id, group_id)
			);
		`);
	}

	/**
	 * Team memberships joined to user rows in memory: JOIN is not
	 * portable SQL, so membership rows and user rows are fetched in
	 * separate queries. Avatar presence comes from a dedicated id
	 * list so avatar blobs never leave the database.
	 */
	private async membersFor(teamIds: string[]): Promise<Map<string, TeamMember[]>> {
		const map = new Map<string, TeamMember[]>();
		if (teamIds.length === 0) return map;
		const links = (await this.db
			.prepare(
				`SELECT team_id, user_id FROM team_members WHERE team_id IN (${inMarks(teamIds.length)})`
			)
			.all(...teamIds)) as unknown as { team_id: string; user_id: number }[];
		const userIds = [...new Set(links.map((l) => l.user_id))];
		const users = new Map<number, UserRow>();
		const withAvatar = new Set<number>();
		if (userIds.length > 0) {
			const uMarks = inMarks(userIds.length);
			const rows = (await this.db
				.prepare(`SELECT id, username, display_name FROM users WHERE id IN (${uMarks})`)
				.all(...userIds)) as unknown as UserRow[];
			for (const r of rows) users.set(r.id, r);
			const avatars = (await this.db
				.prepare(`SELECT id FROM users WHERE id IN (${uMarks}) AND avatar IS NOT NULL`)
				.all(...userIds)) as unknown as { id: number }[];
			for (const r of avatars) withAvatar.add(r.id);
		}
		for (const l of links) {
			const u = users.get(l.user_id);
			if (!u) continue;
			const list = map.get(l.team_id) ?? [];
			list.push({
				id: u.id,
				username: u.username,
				displayName: u.display_name,
				hasAvatar: withAvatar.has(u.id)
			});
			map.set(l.team_id, list);
		}
		for (const list of map.values()) {
			list.sort((a, b) => a.username.localeCompare(b.username));
		}
		return map;
	}

	/** Same in-memory join for the service groups a team can see. */
	private async groupsFor(teamIds: string[]): Promise<Map<string, GroupRef[]>> {
		const map = new Map<string, GroupRef[]>();
		if (teamIds.length === 0) return map;
		const links = (await this.db
			.prepare(
				`SELECT team_id, group_id FROM team_groups WHERE team_id IN (${inMarks(teamIds.length)})`
			)
			.all(...teamIds)) as unknown as { team_id: string; group_id: string }[];
		const groupIds = [...new Set(links.map((l) => l.group_id))];
		const groups = new Map<string, GroupRef>();
		if (groupIds.length > 0) {
			const rows = (await this.db
				.prepare(
					`SELECT id, name, color FROM service_groups WHERE id IN (${inMarks(groupIds.length)})`
				)
				.all(...groupIds)) as unknown as GroupRef[];
			for (const r of rows) groups.set(r.id, r);
		}
		for (const l of links) {
			const g = groups.get(l.group_id);
			if (!g) continue;
			const list = map.get(l.team_id) ?? [];
			list.push({ id: g.id, name: g.name, color: g.color });
			map.set(l.team_id, list);
		}
		for (const list of map.values()) {
			list.sort((a, b) => a.name.localeCompare(b.name));
		}
		return map;
	}

	private toInfo(r: TeamRow, members: TeamMember[], groups: GroupRef[]): TeamInfo {
		return { id: r.id, name: r.name, createdAt: r.created_at, members, groups };
	}

	async create(name: string): Promise<TeamInfo> {
		const n = validName(name);
		const id = `team_${randomBytes(9).toString('base64url')}`;
		const now = Date.now();
		try {
			await this.db
				.prepare('INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)')
				.run(id, n, now);
		} catch (err) {
			if (isUniqueViolation(err)) {
				throw new TeamError(409, 'a team with that name exists');
			}
			throw err;
		}
		return { id, name: n, createdAt: now, members: [], groups: [] };
	}

	async get(id: string): Promise<TeamInfo | null> {
		const r = (await this.db
			.prepare('SELECT id, name, created_at FROM teams WHERE id = ?')
			.get(id)) as TeamRow | undefined;
		if (!r) return null;
		return this.toInfo(
			r,
			(await this.membersFor([id])).get(id) ?? [],
			(await this.groupsFor([id])).get(id) ?? []
		);
	}

	async list(): Promise<TeamInfo[]> {
		const rows = (await this.db
			.prepare('SELECT id, name, created_at FROM teams ORDER BY name')
			.all()) as unknown as TeamRow[];
		const ids = rows.map((r) => r.id);
		const members = await this.membersFor(ids);
		const groups = await this.groupsFor(ids);
		return rows.map((r) => this.toInfo(r, members.get(r.id) ?? [], groups.get(r.id) ?? []));
	}

	async update(id: string, name: string): Promise<TeamInfo | null> {
		const n = validName(name);
		try {
			const res = await this.db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(n, id);
			if (Number(res.changes) === 0) return null;
		} catch (err) {
			if (isUniqueViolation(err)) {
				throw new TeamError(409, 'a team with that name exists');
			}
			throw err;
		}
		return this.get(id);
	}

	/** Removes the team plus its member and group rows atomically. */
	async remove(id: string): Promise<boolean> {
		return this.db.tx(async (tx) => {
			await tx.prepare('DELETE FROM team_members WHERE team_id = ?').run(id);
			await tx.prepare('DELETE FROM team_groups WHERE team_id = ?').run(id);
			const res = await tx.prepare('DELETE FROM teams WHERE id = ?').run(id);
			return Number(res.changes) === 1;
		});
	}

	private async requireTeam(id: string): Promise<void> {
		if (!(await this.db.prepare('SELECT 1 AS x FROM teams WHERE id = ?').get(id))) {
			throw new TeamError(404, 'team not found');
		}
	}

	/**
	 * Add and remove member user ids atomically. Every id must exist in
	 * the users table; adds dedupe on the composite primary key.
	 */
	async setMembers(id: string, add: number[], remove: number[]): Promise<TeamInfo> {
		await this.requireTeam(id);
		const ids = [...new Set([...add, ...remove])];
		if (ids.length > MAX_MEMBERS) throw new TeamError(422, 'too many members');
		if (ids.some((u) => !Number.isInteger(u) || u < 1)) {
			throw new TeamError(422, 'member ids must be positive integers');
		}
		if (ids.length > 0) {
			const found = (await this.db
				.prepare(`SELECT id FROM users WHERE id IN (${inMarks(ids.length)})`)
				.all(...ids)) as unknown as { id: number }[];
			const have = new Set(found.map((r) => r.id));
			const missing = ids.find((u) => !have.has(u));
			if (missing !== undefined) throw new TeamError(422, `user not found: ${missing}`);
		}
		await this.db.tx(async (tx) => {
			const present = tx.prepare(
				'SELECT 1 AS x FROM team_members WHERE team_id = ? AND user_id = ?'
			);
			const ins = tx.prepare('INSERT INTO team_members (team_id, user_id) VALUES (?, ?)');
			// INSERT OR IGNORE is not portable; composite-key rows are
			// deduped with a pre-check instead.
			for (const u of add) {
				if (!(await present.get(id, u))) await ins.run(id, u);
			}
			const del = tx.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?');
			for (const u of remove) await del.run(id, u);
		});
		const team = await this.get(id);
		if (!team) throw new TeamError(500, 'team missing after update');
		return team;
	}

	/** Replace the team's assigned service groups atomically. */
	async setGroups(id: string, groupIds: string[]): Promise<TeamInfo> {
		await this.requireTeam(id);
		const ids = [...new Set(groupIds)];
		if (ids.length > MAX_GROUPS) throw new TeamError(422, 'too many groups');
		if (ids.length > 0) {
			const found = (await this.db
				.prepare(`SELECT id FROM service_groups WHERE id IN (${inMarks(ids.length)})`)
				.all(...ids)) as unknown as { id: string }[];
			const have = new Set(found.map((r) => r.id));
			const missing = ids.find((g) => !have.has(g));
			if (missing !== undefined) throw new TeamError(422, `group not found: ${missing}`);
		}
		await this.db.tx(async (tx) => {
			await tx.prepare('DELETE FROM team_groups WHERE team_id = ?').run(id);
			const ins = tx.prepare('INSERT INTO team_groups (team_id, group_id) VALUES (?, ?)');
			for (const g of ids) await ins.run(id, g);
		});
		const team = await this.get(id);
		if (!team) throw new TeamError(500, 'team missing after update');
		return team;
	}

	/**
	 * Teams a user belongs to, with their groups. Used by the mine
	 * endpoint for dashboard visibility; enforcement beyond visibility
	 * is deferred.
	 */
	async teamsForUser(userId: number): Promise<TeamInfo[]> {
		const links = (await this.db
			.prepare('SELECT team_id FROM team_members WHERE user_id = ?')
			.all(userId)) as unknown as { team_id: string }[];
		if (links.length === 0) return [];
		const ids = links.map((l) => l.team_id);
		const rows = (await this.db
			.prepare(
				`SELECT id, name, created_at FROM teams WHERE id IN (${inMarks(ids.length)}) ORDER BY name`
			)
			.all(...ids)) as unknown as TeamRow[];
		const members = await this.membersFor(ids);
		const groups = await this.groupsFor(ids);
		return rows.map((r) => this.toInfo(r, members.get(r.id) ?? [], groups.get(r.id) ?? []));
	}
}

// Lazy singleton per the runtime-frozen store pattern: routes call
// getTeamStore(getRuntime().db).
const stores = new WeakMap<Db | DatabaseSync, TeamStore>();

export function getTeamStore(db: Db | DatabaseSync): TeamStore {
	const existing = stores.get(db);
	if (existing) return existing;
	const created = new TeamStore(db);
	stores.set(db, created);
	return created;
}
