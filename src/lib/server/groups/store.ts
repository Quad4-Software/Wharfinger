import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { asDb, isUniqueViolation, rawSqlite, type Db } from '$lib/server/store/driver';
import type { GroupMember, GroupRef, ServiceGroup } from '$lib/shared/groups';

export class GroupError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}
}

const NAME_MAX = 64;
const COLOR_RE = /^#[0-9a-f]{6}$/;
// Service members resolve to config-defined ids and app members to
// deploy_apps rows. Shape validation is deliberately loose for services
// since config can rename them; apps must exist.
const MEMBER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MEMBER_KINDS = ['service', 'app'] as const;

interface GroupRow {
	id: string;
	name: string;
	color: string | null;
	created_at: number;
}

interface MemberRow {
	group_id: string;
	member_kind: string;
	member_id: string;
}

function validName(name: string): string {
	const n = name.trim();
	if (n.length < 1 || n.length > NAME_MAX) {
		throw new GroupError(422, 'name must be 1-64 characters');
	}
	return n;
}

function validColor(color: string | null): string | null {
	if (color === null) return null;
	if (!COLOR_RE.test(color)) throw new GroupError(422, 'color must be hex like #3b82f6');
	return color;
}

export class GroupStore {
	private readonly db: Db;

	constructor(db: Db | DatabaseSync) {
		this.db = asDb(db);
		// Lazy DDL is sqlite-only; surreal gets these tables from
		// store/schema.ts.
		rawSqlite(this.db)?.exec(`
			CREATE TABLE IF NOT EXISTS service_groups (
				id         TEXT PRIMARY KEY,
				name       TEXT NOT NULL UNIQUE,
				color      TEXT,
				created_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS service_group_members (
				group_id    TEXT NOT NULL REFERENCES service_groups(id) ON DELETE CASCADE,
				member_kind TEXT NOT NULL,
				member_id   TEXT NOT NULL,
				PRIMARY KEY (group_id, member_kind, member_id)
			);
			CREATE INDEX IF NOT EXISTS idx_sg_members_member ON service_group_members (member_kind, member_id);
		`);
	}

	private async membersFor(groupIds: string[]): Promise<Map<string, GroupMember[]>> {
		const map = new Map<string, GroupMember[]>();
		if (groupIds.length === 0) return map;
		const marks = groupIds.map(() => '?').join(',');
		const rows = (await this.db
			.prepare(
				`SELECT group_id, member_kind, member_id FROM service_group_members WHERE group_id IN (${marks}) ORDER BY member_kind, member_id`
			)
			.all(...groupIds)) as unknown as MemberRow[];
		for (const r of rows) {
			const list = map.get(r.group_id) ?? [];
			list.push({ memberKind: r.member_kind as GroupMember['memberKind'], memberId: r.member_id });
			map.set(r.group_id, list);
		}
		return map;
	}

	private toGroup(r: GroupRow, members: GroupMember[]): ServiceGroup {
		return {
			id: r.id,
			name: r.name,
			color: r.color,
			createdAt: r.created_at,
			memberCount: members.length,
			members
		};
	}

	async create(name: string, color: string | null = null): Promise<ServiceGroup> {
		const n = validName(name);
		const c = validColor(color);
		const id = `grp_${randomBytes(9).toString('base64url')}`;
		const now = Date.now();
		try {
			await this.db
				.prepare('INSERT INTO service_groups (id, name, color, created_at) VALUES (?, ?, ?, ?)')
				.run(id, n, c, now);
		} catch (err) {
			if (isUniqueViolation(err)) {
				throw new GroupError(409, 'a group with that name exists');
			}
			throw err;
		}
		return { id, name: n, color: c, createdAt: now, memberCount: 0, members: [] };
	}

	async get(id: string): Promise<ServiceGroup | null> {
		const r = (await this.db
			.prepare('SELECT id, name, color, created_at FROM service_groups WHERE id = ?')
			.get(id)) as GroupRow | undefined;
		if (!r) return null;
		return this.toGroup(r, (await this.membersFor([r.id])).get(r.id) ?? []);
	}

	async list(): Promise<ServiceGroup[]> {
		const rows = (await this.db
			.prepare('SELECT id, name, color, created_at FROM service_groups ORDER BY name')
			.all()) as unknown as GroupRow[];
		const members = await this.membersFor(rows.map((r) => r.id));
		return rows.map((r) => this.toGroup(r, members.get(r.id) ?? []));
	}

	/** Names and colors for chips; members are not needed by filters. */
	async listRefs(): Promise<GroupRef[]> {
		const rows = (await this.db
			.prepare('SELECT id, name, color FROM service_groups ORDER BY name')
			.all()) as unknown as Pick<GroupRow, 'id' | 'name' | 'color'>[];
		return rows.map((r) => ({ id: r.id, name: r.name, color: r.color }));
	}

	async update(
		id: string,
		patch: { name?: string; color?: string | null }
	): Promise<ServiceGroup | null> {
		const existing = (await this.db
			.prepare('SELECT id FROM service_groups WHERE id = ?')
			.get(id)) as { id: string } | undefined;
		if (!existing) return null;
		const sets: string[] = [];
		const args: (string | null)[] = [];
		if (patch.name !== undefined) {
			sets.push('name = ?');
			args.push(validName(patch.name));
		}
		if (patch.color !== undefined) {
			sets.push('color = ?');
			args.push(validColor(patch.color));
		}
		if (sets.length > 0) {
			args.push(id);
			try {
				await this.db
					.prepare(`UPDATE service_groups SET ${sets.join(', ')} WHERE id = ?`)
					.run(...args);
			} catch (err) {
				if (isUniqueViolation(err)) {
					throw new GroupError(409, 'a group with that name exists');
				}
				throw err;
			}
		}
		return this.get(id);
	}

	/** Removes the group and every membership row in one transaction. */
	async remove(id: string): Promise<boolean> {
		return this.db.tx(async (tx) => {
			await tx.prepare('DELETE FROM service_group_members WHERE group_id = ?').run(id);
			const res = await tx.prepare('DELETE FROM service_groups WHERE id = ?').run(id);
			await tx.prepare('DELETE FROM team_groups WHERE group_id = ?').run(id);
			return Number(res.changes) === 1;
		});
	}

	private async appExists(id: string): Promise<boolean> {
		return (
			(await this.db.prepare('SELECT 1 AS x FROM deploy_apps WHERE id = ?').get(id)) !== undefined
		);
	}

	private async validMember(m: GroupMember): Promise<void> {
		if (!(MEMBER_KINDS as readonly string[]).includes(m.memberKind)) {
			throw new GroupError(422, 'member kind must be service or app');
		}
		if (!MEMBER_ID_RE.test(m.memberId)) {
			throw new GroupError(422, 'member id must be 1-128 chars: letters, digits, _ . : -');
		}
		if (m.memberKind === 'app' && !(await this.appExists(m.memberId))) {
			throw new GroupError(422, `app not found: ${m.memberId}`);
		}
	}

	/**
	 * Add and remove members atomically. Adds dedupe on the composite
	 * primary key; removes ignore members that are not present.
	 */
	async setMembers(id: string, add: GroupMember[], remove: GroupMember[]): Promise<ServiceGroup> {
		if (!(await this.get(id))) throw new GroupError(404, 'group not found');
		for (const m of [...add, ...remove]) await this.validMember(m);
		await this.db.tx(async (tx) => {
			const present = tx.prepare(
				`SELECT 1 AS x FROM service_group_members
				 WHERE group_id = ? AND member_kind = ? AND member_id = ?`
			);
			const ins = tx.prepare(
				'INSERT INTO service_group_members (group_id, member_kind, member_id) VALUES (?, ?, ?)'
			);
			// INSERT OR IGNORE is not portable; the composite key maps to
			// a record id under surreal, so the dedupe is a pre-check.
			for (const m of add) {
				if (!(await present.get(id, m.memberKind, m.memberId))) {
					await ins.run(id, m.memberKind, m.memberId);
				}
			}
			const del = tx.prepare(
				'DELETE FROM service_group_members WHERE group_id = ? AND member_kind = ? AND member_id = ?'
			);
			for (const m of remove) await del.run(id, m.memberKind, m.memberId);
		});
		const group = await this.get(id);
		if (!group) throw new GroupError(500, 'group missing after update');
		return group;
	}

	/** Config service id -> group ids, one pass for the snapshot builder. */
	async serviceGroupIndex(): Promise<Map<string, string[]>> {
		const rows = (await this.db
			.prepare(
				"SELECT group_id, member_id FROM service_group_members WHERE member_kind = 'service'"
			)
			.all()) as unknown as Pick<MemberRow, 'group_id' | 'member_id'>[];
		const map = new Map<string, string[]>();
		for (const r of rows) {
			const list = map.get(r.member_id) ?? [];
			list.push(r.group_id);
			map.set(r.member_id, list);
		}
		return map;
	}

	/** Both lookups the snapshot needs in one call. */
	async snapshotData(): Promise<{ groups: GroupRef[]; byService: Map<string, string[]> }> {
		return { groups: await this.listRefs(), byService: await this.serviceGroupIndex() };
	}
}

// Lazy singleton per the runtime-frozen store pattern: routes and the
// snapshot builder call getGroupStore(getRuntime().db). The runtime
// hands over a Db, so the snapshot path no longer opens its own
// connection.
const stores = new WeakMap<Db | DatabaseSync, GroupStore>();

export function getGroupStore(db: Db | DatabaseSync): GroupStore {
	const existing = stores.get(db);
	if (existing) return existing;
	const created = new GroupStore(db);
	stores.set(db, created);
	return created;
}

export async function groupSnapshotData(
	db: Db | DatabaseSync
): Promise<{ groups: GroupRef[]; byService: Map<string, string[]> }> {
	try {
		return await getGroupStore(db).snapshotData();
	} catch {
		return { groups: [], byService: new Map() };
	}
}
