import type { DatabaseSync } from 'node:sqlite';
import { asDb, type Db } from '$lib/server/store/driver';
import { ALL_PERMISSIONS, isPermission, type Permission } from './authz';
import type { UserStore } from './users';

/** Role names are lowercase, url-safe, and short enough for a select. */
export const ROLE_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export interface RoleInfo {
	name: string;
	label: string;
	permissions: Permission[];
	builtin: boolean;
	createdAt: number;
}

interface RoleRow {
	name: string;
	label: string;
	permissions: string;
	/** 0/1 on sqlite, boolean on surreal. */
	builtin: number | boolean;
	created_at: number;
}

const SELECT = 'SELECT name, label, permissions, builtin, created_at FROM roles';

// admin is lockout-proof: permsFor ignores its stored row entirely and
// update/remove refuse it. Other builtins may be edited but not deleted.
const BUILTINS: { name: string; label: string; permissions: Permission[] }[] = [
	{ name: 'admin', label: 'Admin', permissions: [...ALL_PERMISSIONS] },
	{
		name: 'operator',
		label: 'Operator',
		permissions: [
			'status.view',
			'status.manage',
			'notifications.test',
			'deploy.view',
			'scan.view',
			'anomaly.view',
			'groups.manage',
			'secrets.manage'
		]
	},
	{ name: 'viewer', label: 'Viewer', permissions: ['status.view', 'scan.view', 'anomaly.view'] }
];

// Seeded builtin rows win over the code defaults, so an install that
// stored the previous defaults would silently keep them. Upgrade only
// rows still byte-identical to a former default; admin-edited builtin
// permissions are left alone.
const LEGACY_BUILTIN_PERMS: Partial<Record<string, string>> = {
	operator: JSON.stringify(['status.view', 'status.manage', 'notifications.test', 'deploy.view']),
	viewer: JSON.stringify(['status.view'])
};

const ADMIN_PERMS: ReadonlySet<Permission> = new Set(ALL_PERMISSIONS);
const NO_PERMS: ReadonlySet<Permission> = new Set();

export type UpdateResult = 'ok' | 'missing' | 'protected';
export type RemoveResult = UpdateResult | 'in_use';

function parsePerms(raw: string): Permission[] {
	try {
		const v = JSON.parse(raw) as unknown;
		return Array.isArray(v) ? v.filter(isPermission) : [];
	} catch {
		return [];
	}
}

/** Validate a client-supplied permission list; rejects unknown strings. */
export function parsePermissions(v: unknown): Permission[] | null {
	if (!Array.isArray(v) || !v.every(isPermission)) return null;
	return [...new Set(v)];
}

function toInfo(r: RoleRow): RoleInfo {
	return {
		name: r.name,
		label: r.label,
		permissions: parsePerms(r.permissions),
		builtin: Boolean(r.builtin),
		createdAt: r.created_at
	};
}

export class RoleStore {
	private readonly db: Db;
	private cache: Map<string, ReadonlySet<Permission>> | null = null;
	// Builtin seeding used to run in the constructor; statement calls
	// are async now, so the seed runs once on first use instead.
	private seeded: Promise<void> | null = null;

	constructor(
		db: Db | DatabaseSync,
		private readonly users: Pick<UserStore, 'countByRole'>
	) {
		this.db = asDb(db);
	}

	private ensureSeeded(): Promise<void> {
		return (this.seeded ??= this.seed());
	}

	private async seed(): Promise<void> {
		const insert = this.db.prepare(
			'INSERT OR IGNORE INTO roles (name, label, permissions, builtin, created_at) VALUES (?, ?, ?, 1, ?)'
		);
		const now = Date.now();
		for (const b of BUILTINS) {
			await insert.run(b.name, b.label, JSON.stringify(b.permissions), now);
			const legacy = LEGACY_BUILTIN_PERMS[b.name];
			if (legacy !== undefined) {
				await this.db
					.prepare(
						'UPDATE roles SET permissions = ? WHERE name = ? AND builtin = 1 AND permissions = ?'
					)
					.run(JSON.stringify(b.permissions), b.name, legacy);
			}
		}
	}

	async list(): Promise<RoleInfo[]> {
		await this.ensureSeeded();
		const rows = (await this.db.prepare(`${SELECT} ORDER BY name`).all()) as unknown as RoleRow[];
		return rows.map(toInfo);
	}

	async get(name: string): Promise<RoleInfo | null> {
		await this.ensureSeeded();
		const r = (await this.db.prepare(`${SELECT} WHERE name = ?`).get(name)) as RoleRow | undefined;
		return r ? toInfo(r) : null;
	}

	async exists(name: string): Promise<boolean> {
		await this.ensureSeeded();
		return (
			(await this.db.prepare('SELECT 1 AS x FROM roles WHERE name = ?').get(name)) !== undefined
		);
	}

	/**
	 * Resolved permission set for a role name. Unknown roles fail closed
	 * to an empty set; admin always returns the full set.
	 */
	async permsFor(name: string): Promise<ReadonlySet<Permission>> {
		if (name === 'admin') return ADMIN_PERMS;
		await this.ensureSeeded();
		if (this.cache === null) {
			this.cache = new Map();
			const rows = (await this.db
				.prepare('SELECT name, permissions FROM roles')
				.all()) as unknown as Pick<RoleRow, 'name' | 'permissions'>[];
			for (const r of rows) {
				this.cache.set(r.name, new Set(parsePerms(r.permissions)));
			}
		}
		return this.cache.get(name) ?? NO_PERMS;
	}

	async create(name: string, label: string, permissions: Permission[]): Promise<RoleInfo> {
		await this.ensureSeeded();
		await this.db
			.prepare(
				'INSERT INTO roles (name, label, permissions, builtin, created_at) VALUES (?, ?, ?, 0, ?)'
			)
			.run(name, label, JSON.stringify(permissions), Date.now());
		this.cache = null;
		const info = await this.get(name);
		if (!info) throw new Error('role insert failed');
		return info;
	}

	async update(name: string, label: string, permissions: Permission[]): Promise<UpdateResult> {
		if (name === 'admin') return 'protected';
		if (!(await this.exists(name))) return 'missing';
		await this.db
			.prepare('UPDATE roles SET label = ?, permissions = ? WHERE name = ?')
			.run(label, JSON.stringify(permissions), name);
		this.cache = null;
		return 'ok';
	}

	async remove(name: string): Promise<RemoveResult> {
		if (name === 'admin') return 'protected';
		const info = await this.get(name);
		if (!info) return 'missing';
		if (info.builtin) return 'protected';
		if ((await this.users.countByRole(name)) > 0) return 'in_use';
		await this.db.prepare('DELETE FROM roles WHERE name = ?').run(name);
		this.cache = null;
		return 'ok';
	}
}
