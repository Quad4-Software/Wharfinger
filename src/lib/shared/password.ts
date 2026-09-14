// Client-side password strength estimate, dependency-free. Mirrors the
// server policy in src/lib/server/admin/policy.ts so the meter agrees
// with what the API will accept; it is feedback, not enforcement.

export interface PasswordStrength {
	/** 0-4 bars. */
	score: number;
	label: string;
	/** Actionable nudges, weakest signals first. */
	hints: string[];
	/** Fails the server-side policy; submission will be rejected. */
	rejected: string | null;
}

const LABELS = ['very weak', 'weak', 'fair', 'strong', 'very strong'];

const COMMON = [
	'password',
	'passw0rd',
	'letmein',
	'welcome',
	'admin',
	'status',
	'monitor',
	'qwerty',
	'abc123',
	'iloveyou',
	'dragon',
	'master',
	'login',
	'changeme'
];

const SEQUENCES = /(?:0123|1234|2345|3456|4567|5678|6789|abcd|qwer|asdf|zxcv)/i;
const REPEATS = /(.)\1{2,}/;

/**
 * Random strong password for admin-generated credentials: 20 chars
 * across all classes, crypto-seeded. Only used client-side in the
 * panel, where crypto.getRandomValues is always available.
 */
export function generatePassword(length = 20): string {
	const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*+-=?';
	const bytes = new Uint32Array(length);
	crypto.getRandomValues(bytes);
	let out = '';
	for (const b of bytes) out += alphabet[b % alphabet.length];
	return out;
}

export function passwordStrength(
	password: string,
	opts: { username?: string; minLength?: number } = {}
): PasswordStrength {
	const min = opts.minLength ?? 12;
	const hints: string[] = [];
	let rejected: string | null = null;

	if (password.length === 0) {
		return { score: 0, label: LABELS[0], hints: [], rejected: null };
	}

	if (password.length < min) rejected = `needs at least ${min} characters`;
	if (password.length > 256) rejected = 'too long';
	if (opts.username && password.toLowerCase().includes(opts.username.toLowerCase())) {
		rejected = 'must not contain the username';
	}

	let score = 0;
	// Length is the dominant factor; the bar fills as it passes the
	// policy floor and keeps growing past it.
	if (password.length >= min) score += 1;
	if (password.length >= min + 4) score += 1;
	if (password.length >= min + 12) score += 1;

	const classes =
		Number(/[a-z]/.test(password)) +
		Number(/[A-Z]/.test(password)) +
		Number(/[0-9]/.test(password)) +
		Number(/[^a-zA-Z0-9]/.test(password));
	if (classes >= 3) score += 1;

	const lower = password.toLowerCase();
	const commonHit = COMMON.some((w) => lower.includes(w));
	if (commonHit) score = Math.min(score, 1);
	if (SEQUENCES.test(lower)) score = Math.min(score, 2);
	if (REPEATS.test(password)) score = Math.min(score, 2);

	if (password.length < min) hints.push(`use ${min}+ characters`);
	if (classes < 3) hints.push('mix upper, lower, digits, symbols');
	if (commonHit) hints.push('avoid common words');
	if (SEQUENCES.test(lower) || REPEATS.test(password)) {
		hints.push('avoid sequences and repeats');
	}
	if (opts.username && lower.includes(opts.username.toLowerCase())) {
		hints.push('do not reuse the username');
	}

	return { score: Math.min(4, score), label: LABELS[Math.min(4, score)], hints, rejected };
}
