import type { DatabaseSync } from 'node:sqlite';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import type { StatusConfig } from '$lib/server/config/schema';
import type { PasskeyInfo } from '$lib/shared/auth';
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
	public_key: Uint8Array;
	counter: number;
	transports: string | null;
	name: string;
	backed_up: number;
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
		publicKey: r.public_key,
		counter: r.counter,
		transports,
		name: r.name,
		backedUp: r.backed_up === 1,
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
	constructor(private readonly db: DatabaseSync) {}

	forUser(userId: number): PasskeyCredential[] {
		const rows = this.db
			.prepare(`${SELECT} WHERE user_id = ? ORDER BY created_at`)
			.all(userId) as unknown as CredentialRow[];
		return rows.map(toCredential);
	}

	byCredentialId(credentialId: string): PasskeyCredential | null {
		const r = this.db.prepare(`${SELECT} WHERE credential_id = ?`).get(credentialId) as
			CredentialRow | undefined;
		return r ? toCredential(r) : null;
	}

	/** Insert a verified credential; null when the credential id already exists. */
	insert(opts: {
		userId: number;
		credentialId: string;
		publicKey: Uint8Array;
		counter: number;
		transports: string[];
		name: string;
		backedUp: boolean;
	}): PasskeyCredential | null {
		if (this.byCredentialId(opts.credentialId)) return null;
		const r = this.db
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
		const row = this.db.prepare(`${SELECT} WHERE id = ?`).get(Number(r.lastInsertRowid)) as
			CredentialRow | undefined;
		return row ? toCredential(row) : null;
	}

	rename(id: number, userId: number, name: string): boolean {
		const r = this.db
			.prepare('UPDATE webauthn_credentials SET name = ? WHERE id = ? AND user_id = ?')
			.run(name, id, userId);
		return Number(r.changes) === 1;
	}

	/** Owner-scoped delete; admins manage only their own passkeys in v1. */
	remove(id: number, userId: number): PasskeyCredential | null {
		const row = this.db.prepare(`${SELECT} WHERE id = ? AND user_id = ?`).get(id, userId) as
			CredentialRow | undefined;
		if (!row) return null;
		this.db.prepare('DELETE FROM webauthn_credentials WHERE id = ?').run(id);
		return toCredential(row);
	}

	/**
	 * Record a successful assertion and its reported counter. Both
	 * sides reporting nonzero while the value fails to advance means
	 * the authenticator was cloned; the credential is deleted and the
	 * caller must refuse the login.
	 */
	recordUse(
		id: number,
		newCounter: number,
		backedUp: boolean,
		now = Date.now()
	): 'ok' | 'cloned' | 'missing' {
		const row = this.db.prepare('SELECT counter FROM webauthn_credentials WHERE id = ?').get(id) as
			{ counter: number } | undefined;
		if (!row) return 'missing';
		if (row.counter > 0 && newCounter > 0 && newCounter <= row.counter) {
			this.db.prepare('DELETE FROM webauthn_credentials WHERE id = ?').run(id);
			return 'cloned';
		}
		this.db
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
	putChallenge(
		token: string,
		kind: ChallengeKind,
		userId: number | null,
		ttlMs: number,
		now = Date.now()
	): void {
		this.db
			.prepare(
				'INSERT INTO webauthn_challenges (token_hash, kind, user_id, expires_at) VALUES (?, ?, ?, ?)'
			)
			.run(hashToken(token), kind, userId, now + ttlMs);
	}

	/** Unexpired challenge lookup that leaves the row claimable. */
	peekChallenge(token: string, kind: ChallengeKind, now = Date.now()): PendingChallenge | null {
		const r = this.db
			.prepare(
				'SELECT user_id, expires_at FROM webauthn_challenges WHERE token_hash = ? AND kind = ?'
			)
			.get(hashToken(token), kind) as ChallengeRow | undefined;
		if (!r || r.expires_at <= now) return null;
		return { userId: r.user_id, expiresAt: r.expires_at };
	}

	/**
	 * Atomically consume a challenge. The conditional delete is the
	 * single-use guarantee, same pattern as InviteStore.tryClaim: two
	 * racing verifies both peek, but only the first delete wins.
	 */
	consumeChallenge(token: string, kind: ChallengeKind, now = Date.now()): PendingChallenge | null {
		const pending = this.peekChallenge(token, kind, now);
		if (!pending) return null;
		const r = this.db
			.prepare('DELETE FROM webauthn_challenges WHERE token_hash = ? AND expires_at > ?')
			.run(hashToken(token), now);
		return Number(r.changes) === 1 ? pending : null;
	}

	prune(now = Date.now()): number {
		return Number(
			this.db.prepare('DELETE FROM webauthn_challenges WHERE expires_at <= ?').run(now).changes
		);
	}
}
