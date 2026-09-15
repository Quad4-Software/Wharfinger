import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify a provider signature over a raw webhook body. Three styles
 * are accepted: GitHub X-Hub-Signature-256 (HMAC over the body),
 * GitLab X-Gitlab-Token (shared token), and X-Quad4-Secret (shared
 * token for custom forges). All comparisons are constant-time and
 * length-checked first so mismatched inputs never reach the compare.
 */
export function hookSignatureOk(headers: Headers, body: string, secret: string): boolean {
	const gh = headers.get('x-hub-signature-256') ?? '';
	const gl = headers.get('x-gitlab-token') ?? '';
	const plain = headers.get('x-wharfinger-secret') ?? '';
	const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
	return (
		(gh.length === expected.length && timingSafeEqual(Buffer.from(gh), Buffer.from(expected))) ||
		(gl.length === secret.length && timingSafeEqual(Buffer.from(gl), Buffer.from(secret))) ||
		(plain.length === secret.length && timingSafeEqual(Buffer.from(plain), Buffer.from(secret)))
	);
}

/** Parse a push payload: ref, head commit, and touched paths across forge shapes. */
export function parsePush(text: string): {
	ref: string;
	commit: string | null;
	paths: string[];
} | null {
	let payload: {
		ref?: unknown;
		checkout_sha?: unknown;
		after?: unknown;
		commits?: unknown;
		head_commit?: unknown;
	};
	try {
		payload = JSON.parse(text) as typeof payload;
	} catch {
		return null;
	}
	const ref = typeof payload.ref === 'string' ? payload.ref : '';
	const commit =
		typeof payload.after === 'string'
			? payload.after.slice(0, 64)
			: typeof payload.checkout_sha === 'string'
				? payload.checkout_sha.slice(0, 64)
				: null;
	return { ref, commit, paths: pushPaths(payload) };
}

const PUSH_PATH_KEYS = ['added', 'modified', 'removed'] as const;
const MAX_PUSH_PATHS = 2000;

// GitHub, GitLab, and Gitea push events all carry commits[] and
// head_commit objects with added/modified/removed path lists.
function pushPaths(payload: { commits?: unknown; head_commit?: unknown }): string[] {
	const out = new Set<string>();
	const take = (entry: unknown) => {
		if (typeof entry !== 'object' || entry === null) return;
		for (const key of PUSH_PATH_KEYS) {
			const list = (entry as Record<string, unknown>)[key];
			if (!Array.isArray(list)) continue;
			for (const p of list) {
				if (typeof p === 'string' && out.size < MAX_PUSH_PATHS) out.add(p);
			}
		}
	};
	if (Array.isArray(payload.commits)) {
		for (const c of payload.commits.slice(0, 200)) take(c);
	}
	take(payload.head_commit);
	return [...out];
}

/**
 * One pull/merge-request lifecycle event. 'update' covers opened,
 * reopened, and synchronize (new head push); 'close' covers closed
 * and merged, which both mean teardown.
 */
export interface PREvent {
	action: 'update' | 'close';
	pr: number;
	sha: string | null;
}

const MAX_PR_NUMBER = 10_000_000;

/**
 * True when the delivery headers mark a pull/merge-request event,
 * whatever the action. The route uses this to keep unhandled PR
 * actions (edited, labeled) out of the push-deploy path.
 */
export function isPRWebhook(headers: Headers): boolean {
	const ghEvent = (
		headers.get('x-github-event') ??
		headers.get('x-gitea-event') ??
		headers.get('x-forgejo-event') ??
		''
	).toLowerCase();
	return ghEvent === 'pull_request' || headers.get('x-gitlab-event') === 'Merge Request Hook';
}

/**
 * Parse a PR/MR webhook event; null when the event is not a pull
 * request or carries no usable number. GitHub and Gitea/Forgejo
 * share the pull_request shape; GitLab sends a Merge Request Hook
 * with object_attributes.
 */
export function parsePREvent(headers: Headers, text: string): PREvent | null {
	if (!isPRWebhook(headers)) return null;
	const glEvent = headers.get('x-gitlab-event') ?? '';

	let payload: Record<string, unknown>;
	try {
		payload = JSON.parse(text) as Record<string, unknown>;
	} catch {
		return null;
	}

	if (glEvent === 'Merge Request Hook') {
		const attrs = payload.object_attributes as Record<string, unknown> | undefined;
		if (payload.object_kind !== 'merge_request' || !attrs) return null;
		const pr = Number(attrs.iid);
		if (!Number.isInteger(pr) || pr < 1 || pr > MAX_PR_NUMBER) return null;
		const action = String(attrs.action);
		const last = attrs.last_commit as Record<string, unknown> | undefined;
		const sha = typeof last?.id === 'string' ? last.id.slice(0, 64) : null;
		if (action === 'close' || action === 'merge') return { action: 'close', pr, sha };
		if (action === 'open' || action === 'reopen' || action === 'update') {
			return { action: 'update', pr, sha };
		}
		return null;
	}

	const prObj = payload.pull_request as Record<string, unknown> | undefined;
	const head = prObj?.head as Record<string, unknown> | undefined;
	const pr = Number(payload.number ?? prObj?.number);
	if (!Number.isInteger(pr) || pr < 1 || pr > MAX_PR_NUMBER) return null;
	const sha = typeof head?.sha === 'string' ? head.sha.slice(0, 64) : null;
	const action = String(payload.action);
	if (action === 'closed') return { action: 'close', pr, sha };
	if (action === 'opened' || action === 'reopened' || action === 'synchronize') {
		return { action: 'update', pr, sha };
	}
	return null;
}

/**
 * The fetchable ref a forge exposes for a pull/merge request head.
 * GitHub, Gitea, and Forgejo keep refs/pull/<n>/head; GitLab keeps
 * refs/merge-requests/<n>/head. Fetching the ref (not the bare sha)
 * needs no uploadpack.allowAnySHA1InWant on the server.
 */
export function prHeadRef(forge: string | undefined, pr: number): string {
	return forge === 'gitlab' ? `refs/merge-requests/${pr}/head` : `refs/pull/${pr}/head`;
}

/** True when the push targets the app's configured branch. */
export function branchMatches(ref: string, want: string): boolean {
	if (!ref.startsWith('refs/heads/')) return true;
	return ref.slice('refs/heads/'.length) === want;
}

/**
 * Monorepo path filter. A filter without wildcards matches the exact
 * path or anything under it as a directory prefix; `*` matches one
 * path segment and `**` any depth. An empty touched-path list means
 * the event carries no file detail, so it always deploys.
 */
export function pathsMatch(filters: string[], touched: string[]): boolean {
	if (!touched.length) return true;
	return touched.some((p) => filters.some((f) => globMatch(f, p)));
}

function globMatch(filter: string, path: string): boolean {
	if (!filter.includes('*')) {
		return path === filter || path.startsWith(filter.endsWith('/') ? filter : filter + '/');
	}
	// ** spans zero or more whole segments; a trailing ** is plain
	// "anything below" since the leading slash is already emitted.
	const segs = filter.split('/');
	let re = '^';
	for (let i = 0; i < segs.length; i++) {
		if (i > 0 && segs[i - 1] !== '**') re += '/';
		const seg = segs[i];
		if (seg === '**') {
			re += i === segs.length - 1 ? '.*' : '(?:[^/]+/)*';
			continue;
		}
		re += seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
	}
	return new RegExp(re + '$').test(path);
}
