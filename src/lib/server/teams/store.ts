import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
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

interface MemberJoinRow {
	id: number;
	username: string;
	display_name: string;
	has_avatar: number;
}

function validName(name: string): string {
	const n = name.trim();
	if (n.length < 1 || n.length > NAME_MAX) {
		throw new TeamError(422, 'name must be 1-64 characters');
	}
	return n;
}

export class TeamStore {
	constructor(private readonly db: DatabaseSync) {
		this.db.exec(`
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

	private membersFor(teamIds: string[]): Map<string, TeamMember[]> {
		const map = new Map<string, TeamMember[]>();
		if (teamIds.length === 0) return map;
		const marks = teamIds.map(() => '?').join(',');
		const rows = this.db
			.prepare(
				`SELECT tm.team_id, u.id, u.username, u.display_name, u.avatar IS NOT NULL AS has_avatar
				 FROM team_members tm JOIN users u ON u.id = tm.user_id
				 WHERE tm.team_id IN (${marks}) ORDER BY u.username`
			)
			.all(...teamIds) as unknown as (MemberJoinRow & { team_id: string })[];
		for (const r of rows) {
			const list = map.get(r.team_id) ?? [];
			list.push({
				id: r.id,
				username: r.username,
				displayName: r.display_name,
				hasAvatar: r.has_avatar === 1
			});
			map.set(r.team_id, list);
		}
		return map;
	}

	private groupsFor(teamIds: string[]): Map<string, GroupRef[]> {
		const map = new Map<string, GroupRef[]>();
		if (teamIds.length === 0) return map;
		const marks = teamIds.map(() => '?').join(',');
		const rows = this.db
			.prepare(
				`SELECT tg.team_id, g.id, g.name, g.color
				 FROM team_groups tg JOIN service_groups g ON g.id = tg.group_id
				 WHERE tg.team_id IN (${marks}) ORDER BY g.name`
			)
			.all(...teamIds) as unknown as ({ team_id: string } & GroupRef)[];
		for (const r of rows) {
			const list = map.get(r.team_id) ?? [];
			list.push({ id: r.id, name: r.name, color: r.color });
			map.set(r.team_id, list);
		}
		return map;
	}

	private toInfo(r: TeamRow, members: TeamMember[], groups: GroupRef[]): TeamInfo {
		return { id: r.id, name: r.name, createdAt: r.created_at, members, groups };
	}

	create(name: string): TeamInfo {
		const n = validName(name);
		const id = `team_${randomBytes(9).toString('base64url')}`;
		const now = Date.now();
		try {
			this.db.prepare('INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)').run(id, n, now);
		} catch (err) {
			if (String(err).includes('UNIQUE')) {
				throw new TeamError(409, 'a team with that name exists');
			}
			throw err;
		}
		return { id, name: n, createdAt: now, members: [], groups: [] };
	}

	get(id: string): TeamInfo | null {
		const r = this.db.prepare('SELECT id, name, created_at FROM teams WHERE id = ?').get(id) as
			TeamRow | undefined;
		if (!r) return null;
		return this.toInfo(r, this.membersFor([id]).get(id) ?? [], this.groupsFor([id]).get(id) ?? []);
	}

	list(): TeamInfo[] {
		const rows = this.db
			.prepare('SELECT id, name, created_at FROM teams ORDER BY name')
			.all() as unknown as TeamRow[];
		const ids = rows.map((r) => r.id);
		const members = this.membersFor(ids);
		const groups = this.groupsFor(ids);
		return rows.map((r) => this.toInfo(r, members.get(r.id) ?? [], groups.get(r.id) ?? []));
	}

	update(id: string, name: string): TeamInfo | null {
		const n = validName(name);
		try {
			const changes = this.db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(n, id).changes;
			if (Number(changes) === 0) return null;
		} catch (err) {
			if (String(err).includes('UNIQUE')) {
				throw new TeamError(409, 'a team with that name exists');
			}
			throw err;
		}
		return this.get(id);
	}

	/** Removes the team plus its member and group rows atomically. */
	remove(id: string): boolean {
		this.db.exec('BEGIN IMMEDIATE');
		try {
			this.db.prepare('DELETE FROM team_members WHERE team_id = ?').run(id);
			this.db.prepare('DELETE FROM team_groups WHERE team_id = ?').run(id);
			const n = this.db.prepare('DELETE FROM teams WHERE id = ?').run(id).changes;
			this.db.exec('COMMIT');
			return Number(n) === 1;
		} catch (err) {
			this.db.exec('ROLLBACK');
			throw err;
		}
	}

	private requireTeam(id: string): void {
		if (!this.db.prepare('SELECT 1 AS x FROM teams WHERE id = ?').get(id)) {
			throw new TeamError(404, 'team not found');
		}
	}

	/**
	 * Add and remove member user ids atomically. Every id must exist in
	 * the users table; adds dedupe on the composite primary key.
	 */
	setMembers(id: string, add: number[], remove: number[]): TeamInfo {
		this.requireTeam(id);
		const ids = [...new Set([...add, ...remove])];
		if (ids.length > MAX_MEMBERS) throw new TeamError(422, 'too many members');
		if (ids.some((u) => !Number.isInteger(u) || u < 1)) {
			throw new TeamError(422, 'member ids must be positive integers');
		}
		if (ids.length > 0) {
			const marks = ids.map(() => '?').join(',');
			const found = this.db
				.prepare(`SELECT id FROM users WHERE id IN (${marks})`)
				.all(...ids) as unknown as { id: number }[];
			const have = new Set(found.map((r) => r.id));
			const missing = ids.find((u) => !have.has(u));
			if (missing !== undefined) throw new TeamError(422, `user not found: ${missing}`);
		}
		this.db.exec('BEGIN IMMEDIATE');
		try {
			const ins = this.db.prepare(
				'INSERT OR IGNORE INTO team_members (team_id, user_id) VALUES (?, ?)'
			);
			for (const u of add) ins.run(id, u);
			const del = this.db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?');
			for (const u of remove) del.run(id, u);
			this.db.exec('COMMIT');
		} catch (err) {
			this.db.exec('ROLLBACK');
			throw err;
		}
		const team = this.get(id);
		if (!team) throw new TeamError(500, 'team missing after update');
		return team;
	}

	/** Replace the team's assigned service groups atomically. */
	setGroups(id: string, groupIds: string[]): TeamInfo {
		this.requireTeam(id);
		const ids = [...new Set(groupIds)];
		if (ids.length > MAX_GROUPS) throw new TeamError(422, 'too many groups');
		if (ids.length > 0) {
			const marks = ids.map(() => '?').join(',');
			const found = this.db
				.prepare(`SELECT id FROM service_groups WHERE id IN (${marks})`)
				.all(...ids) as unknown as { id: string }[];
			const have = new Set(found.map((r) => r.id));
			const missing = ids.find((g) => !have.has(g));
			if (missing !== undefined) throw new TeamError(422, `group not found: ${missing}`);
		}
		this.db.exec('BEGIN IMMEDIATE');
		try {
			this.db.prepare('DELETE FROM team_groups WHERE team_id = ?').run(id);
			const ins = this.db.prepare('INSERT INTO team_groups (team_id, group_id) VALUES (?, ?)');
			for (const g of ids) ins.run(id, g);
			this.db.exec('COMMIT');
		} catch (err) {
			this.db.exec('ROLLBACK');
			throw err;
		}
		const team = this.get(id);
		if (!team) throw new TeamError(500, 'team missing after update');
		return team;
	}

	/**
	 * Teams a user belongs to, with their groups. Used by the mine
	 * endpoint for dashboard visibility; enforcement beyond visibility
	 * is deferred.
	 */
	teamsForUser(userId: number): TeamInfo[] {
		const rows = this.db
			.prepare(
				`SELECT t.id, t.name, t.created_at FROM teams t
				 JOIN team_members tm ON tm.team_id = t.id
				 WHERE tm.user_id = ? ORDER BY t.name`
			)
			.all(userId) as unknown as TeamRow[];
		const ids = rows.map((r) => r.id);
		const members = this.membersFor(ids);
		const groups = this.groupsFor(ids);
		return rows.map((r) => this.toInfo(r, members.get(r.id) ?? [], groups.get(r.id) ?? []));
	}
}

// Lazy singleton per the runtime-frozen store pattern: routes call
// getTeamStore(getRuntime().db).
const stores = new WeakMap<DatabaseSync, TeamStore>();

export function getTeamStore(db: DatabaseSync): TeamStore {
	const existing = stores.get(db);
	if (existing) return existing;
	const created = new TeamStore(db);
	stores.set(db, created);
	return created;
}
