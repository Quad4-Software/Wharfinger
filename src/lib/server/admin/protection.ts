import type { DatabaseSync } from 'node:sqlite';
import { LOGIN_ATTEMPT_RETENTION_MS } from '$lib/server/constants';

export interface LockoutPolicy {
	maxAttempts: number;
	lockoutMs: number;
}

// Progressive back-off for an account under distributed attack. Once
// failures on a username pass the threshold, each attempt pays an
// exponential delay capped well below the lockout window. A delay -
// not a deny - is the right response here: a hard per-username lockout
// lets any attacker with a list of source IPs freeze the legitimate
// owner out indefinitely.
const DELAY_BASE_MS = 250;
const DELAY_MAX_MS = 5_000;

/**
 * Persistent login brute-force protection. Attempts are recorded per
 * key (client IP) and per account. The hard lockout applies to the
 * source key only; the username side contributes a progressive delay
 * so distributed sprays are slowed without locking out the owner.
 */
export class LoginProtector {
	constructor(private readonly db: DatabaseSync) {}

	record(key: string, username: string | null, ok: boolean, now = Date.now()): void {
		this.db
			.prepare('INSERT INTO login_attempts (key, username, ok, at) VALUES (?, ?, ?, ?)')
			.run(key, username?.slice(0, 128) ?? null, ok ? 1 : 0, now);
	}

	private count(where: string, args: (string | number)[], sinceMs: number): number {
		const r = this.db
			.prepare(`SELECT COUNT(*) AS n FROM login_attempts WHERE ${where} AND ok = 0 AND at >= ?`)
			.get(...args, sinceMs) as { n: number };
		return r.n;
	}

	private lastKeyFailure(key: string): number | null {
		const r = this.db
			.prepare('SELECT MAX(at) AS m FROM login_attempts WHERE key = ? AND ok = 0')
			.get(key) as { m: number | null };
		return r.m;
	}

	/** Epoch ms until which this source key is locked, or null. */
	lockedUntil(key: string, policy: LockoutPolicy): number | null {
		const since = Date.now() - policy.lockoutMs;
		if (this.count('key = ?', [key], since) < policy.maxAttempts) return null;
		const last = this.lastKeyFailure(key);
		if (last === null) return null;
		return last + policy.lockoutMs;
	}

	/**
	 * Milliseconds a login attempt for this username should be delayed
	 * based on recent failures from every source. Legitimate owners
	 * still get in after a few seconds; a spray gets exponentially
	 * slower the longer it runs.
	 */
	usernameDelayMs(username: string, policy: LockoutPolicy): number {
		const since = Date.now() - policy.lockoutMs;
		const n = this.count('username = ?', [username], since);
		const over = n - policy.maxAttempts;
		if (over < 0) return 0;
		return Math.min(DELAY_BASE_MS * (1 << Math.min(over, 6)), DELAY_MAX_MS);
	}

	prune(now = Date.now()): number {
		return Number(
			this.db
				.prepare('DELETE FROM login_attempts WHERE at < ?')
				.run(now - LOGIN_ATTEMPT_RETENTION_MS).changes
		);
	}
}
