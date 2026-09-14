import type { DatabaseSync } from 'node:sqlite';
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
	has_avatar: number;
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
		hasAvatar: row.has_avatar === 1
	};
}

export class UserStore {
	constructor(private readonly db: DatabaseSync) {}

	count(): number {
		const r = this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
		return r.n;
	}

	countByRole(role: string): number {
		const r = this.db.prepare('SELECT COUNT(*) AS n FROM users WHERE role = ?').get(role) as {
			n: number;
		};
		return r.n;
	}

	admins(): User[] {
		return (this.db.prepare(`${SELECT} WHERE role = 'admin'`).all() as unknown as UserRow[]).map(
			toPublic
		);
	}

	all(): User[] {
		return (this.db.prepare(`${SELECT} ORDER BY username`).all() as unknown as UserRow[]).map(
			toPublic
		);
	}

	byId(id: number): User | null {
		const r = this.db.prepare(`${SELECT} WHERE id = ?`).get(id) as UserRow | undefined;
		return r ? toPublic(r) : null;
	}

	/** Internal row including credentials; never serialized to clients. */
	rowByName(username: string): UserRow | null {
		return (
			(this.db.prepare(`${SELECT} WHERE username = ?`).get(username) as UserRow | undefined) ?? null
		);
	}

	rowById(id: number): UserRow | null {
		return (this.db.prepare(`${SELECT} WHERE id = ?`).get(id) as UserRow | undefined) ?? null;
	}

	create(username: string, password: string, role: Role, displayName = ''): User {
		const r = this.db
			.prepare(
				'INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)'
			)
			.run(username, displayName, hashPassword(password), role, Date.now());
		const user = this.byId(Number(r.lastInsertRowid));
		if (!user) throw new Error('failed to read newly created user');
		return user;
	}

	/**
	 * First-run setup: the emptiness check and the insert are one
	 * transaction so two racing setup posts cannot both create an
	 * admin. Returns null once any user exists.
	 */
	createFirstUser(username: string, password: string, role: Role, displayName = ''): User | null {
		this.db.exec('BEGIN IMMEDIATE');
		try {
			const n = (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
			if (n > 0) {
				this.db.exec('ROLLBACK');
				return null;
			}
			const r = this.db
				.prepare(
					'INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)'
				)
				.run(username, displayName, hashPassword(password), role, Date.now());
			this.db.exec('COMMIT');
			const user = this.byId(Number(r.lastInsertRowid));
			if (!user) throw new Error('failed to read newly created user');
			return user;
		} catch (err) {
			try {
				this.db.exec('ROLLBACK');
			} catch {
				// already rolled back
			}
			throw err;
		}
	}

	/**
	 * Look up an externally-authenticated account (oidc/ldap) by its
	 * stable external id. External ids are unique per source.
	 */
	rowByExternal(source: string, externalId: string): UserRow | null {
		return (
			(this.db.prepare(`${SELECT} WHERE source = ? AND external_id = ?`).get(source, externalId) as
				UserRow | undefined) ?? null
		);
	}

	/**
	 * Provision an externally-authenticated user. Password hash stays
	 * empty, so the local password path can never match these rows.
	 */
	createExternal(
		username: string,
		displayName: string,
		role: Role,
		source: string,
		externalId: string
	): User {
		const r = this.db
			.prepare(
				'INSERT INTO users (username, display_name, password_hash, role, created_at, source, external_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
			)
			.run(username, displayName, '', role, Date.now(), source, externalId);
		const user = this.byId(Number(r.lastInsertRowid));
		if (!user) throw new Error('failed to read newly created user');
		return user;
	}

	/** Refresh profile fields an external provider is authoritative for. */
	syncExternal(id: number, displayName: string, role: Role): void {
		this.db
			.prepare('UPDATE users SET display_name = ?, role = ? WHERE id = ?')
			.run(displayName, role, id);
	}

	setPassword(id: number, password: string): void {
		this.db
			.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
			.run(hashPassword(password), id);
	}

	setDisplayName(id: number, name: string): void {
		this.db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, id);
	}

	setAvatar(id: number, data: Uint8Array, mime: string): void {
		this.db
			.prepare('UPDATE users SET avatar = ?, avatar_mime = ? WHERE id = ?')
			.run(data, mime, id);
	}

	clearAvatar(id: number): void {
		this.db.prepare('UPDATE users SET avatar = NULL, avatar_mime = NULL WHERE id = ?').run(id);
	}

	avatarFor(id: number): { data: Uint8Array; mime: string } | null {
		const r = this.db.prepare('SELECT avatar, avatar_mime FROM users WHERE id = ?').get(id) as
			{ avatar: Uint8Array | null; avatar_mime: string | null } | undefined;
		if (!r?.avatar || !r.avatar_mime) return null;
		return { data: r.avatar, mime: r.avatar_mime };
	}

	setRole(id: number, role: Role): void {
		this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
	}

	setDisabled(id: number, disabled: boolean): void {
		this.db
			.prepare('UPDATE users SET disabled_at = ? WHERE id = ?')
			.run(disabled ? Date.now() : null, id);
	}

	touchLogin(id: number, now = Date.now()): void {
		this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, id);
	}

	remove(id: number): void {
		this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
	}

	// TOTP secrets are sealed with the per-install data key.
	setTotp(id: number, secretB32: string | null, backupHashes: string[] | null): void {
		this.db
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

	consumeBackupCode(id: number, hash: string): boolean {
		const row = this.rowById(id);
		if (!row) return false;
		const hashes = this.totpBackupHashes(row);
		const idx = hashes.indexOf(hash);
		if (idx === -1) return false;
		hashes.splice(idx, 1);
		this.db
			.prepare('UPDATE users SET totp_backup = ? WHERE id = ?')
			.run(JSON.stringify(hashes), id);
		return true;
	}
}
