import type { DatabaseSync } from 'node:sqlite';
import { asDb, type Db } from '$lib/server/store/driver';
import { asBytes } from '$lib/server/bytes';
import { hashPassword, openSecret, sealSecret } from './crypto';
import type { PublicUser, Role } from '$lib/shared/auth';

export type { Role } from '$lib/shared/auth';
export type User = PublicUser;

interface UserRow {
	id: number;
	username: string;
	display_name: string;
	password_hash: string;
	role: string;
	totp_secret: string | null;
	totp_backup: string | null;
	created_at: number;
	disabled_at: number | null;
	last_login_at: number | null;
	source: string;
	external_id: string | null;
	/** 0/1 on sqlite, boolean on surreal. */
	has_avatar: number | boolean;
}

const SELECT =
	'SELECT id, username, display_name, password_hash, role, totp_secret, totp_backup, created_at, disabled_at, last_login_at, source, external_id, avatar IS NOT NULL AS has_avatar FROM users';

function toPublic(row: UserRow): User {
	return {
		id: row.id,
		username: row.username,
		displayName: row.display_name,
		role: row.role,
		totpEnabled: row.totp_secret !== null,
		createdAt: row.created_at,
		disabledAt: row.disabled_at,
		lastLoginAt: row.last_login_at,
		hasAvatar: Boolean(row.has_avatar)
	};
}

export class UserStore {
	private readonly db: Db;

	constructor(db: Db | DatabaseSync) {
		this.db = asDb(db);
	}

	async count(): Promise<number> {
		const r = (await this.db.prepare('SELECT COUNT(*) AS n FROM users').get()) as { n: number };
		return r.n;
	}

	async countByRole(role: string): Promise<number> {
		const r = (await this.db
			.prepare('SELECT COUNT(*) AS n FROM users WHERE role = ?')
			.get(role)) as { n: number };
		return r.n;
	}

	async admins(): Promise<User[]> {
		const rows = (await this.db
			.prepare(`${SELECT} WHERE role = 'admin'`)
			.all()) as unknown as UserRow[];
		return rows.map(toPublic);
	}

	async all(): Promise<User[]> {
		const rows = (await this.db
			.prepare(`${SELECT} ORDER BY username`)
			.all()) as unknown as UserRow[];
		return rows.map(toPublic);
	}

	async byId(id: number): Promise<User | null> {
		const r = (await this.db.prepare(`${SELECT} WHERE id = ?`).get(id)) as UserRow | undefined;
		return r ? toPublic(r) : null;
	}

	/**
	 * Internal row including credentials; never serialized to clients.
	 * sqlite matches usernames through the NOCASE unique collation;
	 * SurrealDB keeps the fold in a username_lc shadow col maintained
	 * by the translator, so the lookup branches on the driver kind.
	 */
	async rowByName(username: string): Promise<UserRow | null> {
		const surreal = this.db.kind === 'surreal';
		const r = (await this.db
			.prepare(`${SELECT} WHERE ${surreal ? 'username_lc' : 'username'} = ?`)
			.get(surreal ? username.toLowerCase() : username)) as UserRow | undefined;
		return r ?? null;
	}

	async rowById(id: number): Promise<UserRow | null> {
		return (
			((await this.db.prepare(`${SELECT} WHERE id = ?`).get(id)) as UserRow | undefined) ?? null
		);
	}

	async create(username: string, password: string, role: Role, displayName = ''): Promise<User> {
		const r = await this.db
			.prepare(
				'INSERT INTO users (username, display_name, password_hash, role, created_at, source, external_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
			)
			.run(
				username,
				displayName,
				hashPassword(password),
				role,
				Date.now(),
				'local',
				localExternalId(username)
			);
		const user = await this.byId(Number(r.lastInsertRowid));
		if (!user) throw new Error('failed to read newly created user');
		return user;
	}

	/**
	 * First-run setup: the emptiness check and the insert are one
	 * transaction so two racing setup posts cannot both create an
	 * admin. Returns null once any user exists.
	 */
	async createFirstUser(
		username: string,
		password: string,
		role: Role,
		displayName = ''
	): Promise<User | null> {
		return this.db.tx(async (tx) => {
			const n = ((await tx.prepare('SELECT COUNT(*) AS n FROM users').get()) as { n: number }).n;
			if (n > 0) return null;
			const r = await tx
				.prepare(
					'INSERT INTO users (username, display_name, password_hash, role, created_at, source, external_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
				)
				.run(
					username,
					displayName,
					hashPassword(password),
					role,
					Date.now(),
					'local',
					localExternalId(username)
				);
			const row = (await tx.prepare(`${SELECT} WHERE id = ?`).get(Number(r.lastInsertRowid))) as
				UserRow | undefined;
			if (!row) throw new Error('failed to read newly created user');
			return toPublic(row);
		});
	}

	/**
	 * Look up an externally-authenticated account (oidc/ldap) by its
	 * stable external id. External ids are unique per source.
	 */
	async rowByExternal(source: string, externalId: string): Promise<UserRow | null> {
		return (
			((await this.db
				.prepare(`${SELECT} WHERE source = ? AND external_id = ?`)
				.get(source, externalId)) as UserRow | undefined) ?? null
		);
	}

	/**
	 * Provision an externally-authenticated user. Password hash stays
	 * empty, so the local password path can never match these rows.
	 */
	async createExternal(
		username: string,
		displayName: string,
		role: Role,
		source: string,
		externalId: string
	): Promise<User> {
		const r = await this.db
			.prepare(
				'INSERT INTO users (username, display_name, password_hash, role, created_at, source, external_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
			)
			.run(username, displayName, '', role, Date.now(), source, externalId);
		const user = await this.byId(Number(r.lastInsertRowid));
		if (!user) throw new Error('failed to read newly created user');
		return user;
	}

	/** Refresh profile fields an external provider is authoritative for. */
	async syncExternal(id: number, displayName: string, role: Role): Promise<void> {
		await this.db
			.prepare('UPDATE users SET display_name = ?, role = ? WHERE id = ?')
			.run(displayName, role, id);
	}

	async setPassword(id: number, password: string): Promise<void> {
		await this.db
			.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
			.run(hashPassword(password), id);
	}

	async setDisplayName(id: number, name: string): Promise<void> {
		await this.db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, id);
	}

	async setAvatar(id: number, data: Uint8Array, mime: string): Promise<void> {
		await this.db
			.prepare('UPDATE users SET avatar = ?, avatar_mime = ? WHERE id = ?')
			.run(data, mime, id);
	}

	async clearAvatar(id: number): Promise<void> {
		await this.db
			.prepare('UPDATE users SET avatar = NULL, avatar_mime = NULL WHERE id = ?')
			.run(id);
	}

	async avatarFor(id: number): Promise<{ data: Uint8Array; mime: string } | null> {
		const r = (await this.db
			.prepare('SELECT avatar, avatar_mime FROM users WHERE id = ?')
			.get(id)) as { avatar: unknown; avatar_mime: string | null } | undefined;
		const data = asBytes(r?.avatar);
		if (!data || !r?.avatar_mime) return null;
		return { data, mime: r.avatar_mime };
	}

	async setRole(id: number, role: Role): Promise<void> {
		await this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
	}

	async setDisabled(id: number, disabled: boolean): Promise<void> {
		await this.db
			.prepare('UPDATE users SET disabled_at = ? WHERE id = ?')
			.run(disabled ? Date.now() : null, id);
	}

	async touchLogin(id: number, now = Date.now()): Promise<void> {
		await this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, id);
	}

	async remove(id: number): Promise<void> {
		// SurrealDB has no ON DELETE CASCADE, so FK children go down
		// explicitly in one transaction. On sqlite this duplicates the
		// real cascade and stays harmless.
		await this.db.tx(async (tx) => {
			await tx.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
			await tx.prepare('DELETE FROM invites WHERE user_id = ?').run(id);
			await tx.prepare('DELETE FROM webauthn_credentials WHERE user_id = ?').run(id);
			await tx.prepare('DELETE FROM webauthn_challenges WHERE user_id = ?').run(id);
			await tx.prepare('DELETE FROM users WHERE id = ?').run(id);
		});
	}

	// TOTP secrets are sealed with the per-install data key.
	async setTotp(
		id: number,
		secretB32: string | null,
		backupHashes: string[] | null
	): Promise<void> {
		await this.db
			.prepare('UPDATE users SET totp_secret = ?, totp_backup = ? WHERE id = ?')
			.run(
				secretB32 === null ? null : sealSecret(secretB32),
				backupHashes === null ? null : JSON.stringify(backupHashes),
				id
			);
	}

	totpSecret(row: UserRow): string | null {
		if (!row.totp_secret) return null;
		return openSecret(row.totp_secret);
	}

	totpBackupHashes(row: UserRow): string[] {
		if (!row.totp_backup) return [];
		try {
			return JSON.parse(row.totp_backup) as string[];
		} catch {
			return [];
		}
	}

	async consumeBackupCode(id: number, hash: string): Promise<boolean> {
		const row = await this.rowById(id);
		if (!row) return false;
		const hashes = this.totpBackupHashes(row);
		const idx = hashes.indexOf(hash);
		if (idx === -1) return false;
		hashes.splice(idx, 1);
		await this.db
			.prepare('UPDATE users SET totp_backup = ? WHERE id = ?')
			.run(JSON.stringify(hashes), id);
		return true;
	}
}

// The (source, external_id) unique index cannot stay partial under
// SurrealDB - every row must carry an external_id or the second local
// account trips the unique on ('local', NONE). Local accounts get a
// namespaced id so the pair is always populated and unique.
function localExternalId(username: string): string {
	return `local:${username}`;
}
