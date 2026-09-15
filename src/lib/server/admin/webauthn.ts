import type { DatabaseSync } from 'node:sqlite';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import type { StatusConfig } from '$lib/server/config/schema';
import type { PasskeyInfo } from '$lib/shared/auth';
import { asDb, isUniqueViolation, type Db } from '$lib/server/store/driver';
import { asBytes } from '$lib/server/bytes';
import { hashToken } from './crypto';

export type ChallengeKind = 'register' | 'login';

export interface PasskeyCredential {
	id: number;
	userId: number;
	/** base64url credential id, exactly as the authenticator emitted it. */
	credentialId: string;
	/** Raw COSE public key bytes. */
	publicKey: Uint8Array;
	counter: number;
	transports: string[];
	name: string;
	backedUp: boolean;
	createdAt: number;
	lastUsedAt: number | null;
}

export interface PendingChallenge {
	userId: number | null;
	expiresAt: number;
}

interface CredentialRow {
	id: number;
	user_id: number;
	credential_id: string;
	/** Uint8Array on sqlite, base64 text on surreal. */
	public_key: unknown;
	counter: number;
	transports: string | null;
	name: string;
	/** 0/1 on sqlite, boolean on surreal. */
	backed_up: number | boolean;
	created_at: number;
	last_used_at: number | null;
}

interface ChallengeRow {
	user_id: number | null;
	expires_at: number;
}

const SELECT =
	'SELECT id, user_id, credential_id, public_key, counter, transports, name, backed_up, created_at, last_used_at FROM webauthn_credentials';

function toCredential(r: CredentialRow): PasskeyCredential {
	let transports: string[] = [];
	if (r.transports) {
		try {
			const parsed = JSON.parse(r.transports) as unknown;
			if (Array.isArray(parsed)) transports = parsed.filter((t) => typeof t === 'string');
		} catch {
			transports = [];
		}
	}
	return {
		id: r.id,
		userId: r.user_id,
		credentialId: r.credential_id,
		publicKey: asBytes(r.public_key) ?? new Uint8Array(),
		counter: r.counter,
		transports,
		name: r.name,
		backedUp: Boolean(r.backed_up),
		createdAt: r.created_at,
		lastUsedAt: r.last_used_at
	};
}

export function passkeyInfo(c: PasskeyCredential): PasskeyInfo {
	return {
		id: c.id,
		name: c.name,
		createdAt: c.createdAt,
		lastUsedAt: c.lastUsedAt,
		backedUp: c.backedUp
	};
}

// Passkey ceremonies bind to the relying-party id and origin the
// browser reports. Both default to the request URL, which already
// reflects x-wharfinger-proto (WHARFINGER_TRUST_PROXY aware) through
// PROTOCOL_HEADER; the config overrides cover a panel reached through
// a different public origin or a parent-domain rpID shared across
// subdomains.
export function relyingParty(
	cfg: StatusConfig,
	url: URL
): { rpID: string; origin: string; rpName: string } {
	return {
		rpID: cfg.admin.webauthn_rp_id ?? url.hostname,
		origin: cfg.admin.webauthn_origin ?? url.origin,
		rpName: cfg.site.name
	};
}

// The challenge the authenticator signed rides inside clientDataJSON;
// extracting it lets the verify routes find and consume the matching
// single-use challenge row without trusting a client-supplied lookup
// key.
export function clientDataChallenge(clientDataJSON: unknown): string | null {
	if (
		typeof clientDataJSON !== 'string' ||
		clientDataJSON.length === 0 ||
		clientDataJSON.length > 4096
	) {
		return null;
	}
	try {
		const parsed = JSON.parse(isoBase64URL.toUTF8String(clientDataJSON)) as {
			challenge?: unknown;
		};
		return typeof parsed.challenge === 'string' && parsed.challenge.length > 0
			? parsed.challenge
			: null;
	} catch {
		return null;
	}
}

export class WebAuthnStore {
	private readonly db: Db;

	constructor(db: Db | DatabaseSync) {
		this.db = asDb(db);
	}

	async forUser(userId: number): Promise<PasskeyCredential[]> {
		const rows = (await this.db
			.prepare(`${SELECT} WHERE user_id = ? ORDER BY created_at`)
			.all(userId)) as unknown as CredentialRow[];
		return rows.map(toCredential);
	}

	async byCredentialId(credentialId: string): Promise<PasskeyCredential | null> {
		const r = (await this.db.prepare(`${SELECT} WHERE credential_id = ?`).get(credentialId)) as
			CredentialRow | undefined;
		return r ? toCredential(r) : null;
	}

	/** Insert a verified credential; null when the credential id already exists. */
	async insert(opts: {
		userId: number;
		credentialId: string;
		publicKey: Uint8Array;
		counter: number;
		transports: string[];
		name: string;
		backedUp: boolean;
	}): Promise<PasskeyCredential | null> {
		if (await this.byCredentialId(opts.credentialId)) return null;
		let id: number;
		try {
			const r = await this.db
				.prepare(
					'INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, transports, name, backed_up, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
				)
				.run(
					opts.userId,
					opts.credentialId,
					opts.publicKey,
					opts.counter,
					JSON.stringify(opts.transports),
					opts.name,
					opts.backedUp ? 1 : 0,
					Date.now()
				);
			id = Number(r.lastInsertRowid);
		} catch (err) {
			// A racing insert on the same credential id loses to the
			// unique index; report it the same way as the pre-check.
			if (isUniqueViolation(err)) return null;
			throw err;
		}
		const row = (await this.db.prepare(`${SELECT} WHERE id = ?`).get(id)) as
			CredentialRow | undefined;
		return row ? toCredential(row) : null;
	}

	async rename(id: number, userId: number, name: string): Promise<boolean> {
		const r = await this.db
			.prepare('UPDATE webauthn_credentials SET name = ? WHERE id = ? AND user_id = ?')
			.run(name, id, userId);
		return Number(r.changes) === 1;
	}

	/** Owner-scoped delete; admins manage only their own passkeys in v1. */
	async remove(id: number, userId: number): Promise<PasskeyCredential | null> {
		const row = (await this.db
			.prepare(`${SELECT} WHERE id = ? AND user_id = ?`)
			.get(id, userId)) as CredentialRow | undefined;
		if (!row) return null;
		await this.db.prepare('DELETE FROM webauthn_credentials WHERE id = ?').run(id);
		return toCredential(row);
	}

	/**
	 * Record a successful assertion and its reported counter. Both
	 * sides reporting nonzero while the value fails to advance means
	 * the authenticator was cloned; the credential is deleted and the
	 * caller must refuse the login.
	 */
	async recordUse(
		id: number,
		newCounter: number,
		backedUp: boolean,
		now = Date.now()
	): Promise<'ok' | 'cloned' | 'missing'> {
		const row = (await this.db
			.prepare('SELECT counter FROM webauthn_credentials WHERE id = ?')
			.get(id)) as { counter: number } | undefined;
		if (!row) return 'missing';
		if (row.counter > 0 && newCounter > 0 && newCounter <= row.counter) {
			await this.db.prepare('DELETE FROM webauthn_credentials WHERE id = ?').run(id);
			return 'cloned';
		}
		await this.db
			.prepare(
				'UPDATE webauthn_credentials SET counter = ?, last_used_at = ?, backed_up = ? WHERE id = ?'
			)
			.run(Math.max(row.counter, newCounter), now, backedUp ? 1 : 0, id);
		return 'ok';
	}

	/**
	 * Persist a ceremony challenge emitted by the options generators;
	 * only the sha256 hash is stored. The challenge the authenticator
	 * echoes back in clientDataJSON is the lookup key at verify time.
	 */
	async putChallenge(
		token: string,
		kind: ChallengeKind,
		userId: number | null,
		ttlMs: number,
		now = Date.now()
	): Promise<void> {
		await this.db
			.prepare(
				'INSERT INTO webauthn_challenges (token_hash, kind, user_id, expires_at) VALUES (?, ?, ?, ?)'
			)
			.run(hashToken(token), kind, userId, now + ttlMs);
	}

	/** Unexpired challenge lookup that leaves the row claimable. */
	async peekChallenge(
		token: string,
		kind: ChallengeKind,
		now = Date.now()
	): Promise<PendingChallenge | null> {
		const r = (await this.db
			.prepare(
				'SELECT user_id, expires_at FROM webauthn_challenges WHERE token_hash = ? AND kind = ?'
			)
			.get(hashToken(token), kind)) as ChallengeRow | undefined;
		if (!r || r.expires_at <= now) return null;
		return { userId: r.user_id, expiresAt: r.expires_at };
	}

	/**
	 * Atomically consume a challenge. The conditional delete is the
	 * single-use guarantee, same pattern as InviteStore.tryClaim: two
	 * racing verifies both peek, but only the first delete wins.
	 */
	async consumeChallenge(
		token: string,
		kind: ChallengeKind,
		now = Date.now()
	): Promise<PendingChallenge | null> {
		const pending = await this.peekChallenge(token, kind, now);
		if (!pending) return null;
		const r = await this.db
			.prepare('DELETE FROM webauthn_challenges WHERE token_hash = ? AND expires_at > ?')
			.run(hashToken(token), now);
		return Number(r.changes) === 1 ? pending : null;
	}

	async prune(now = Date.now()): Promise<number> {
		return Number(
			(await this.db.prepare('DELETE FROM webauthn_challenges WHERE expires_at <= ?').run(now))
				.changes
		);
	}
}
