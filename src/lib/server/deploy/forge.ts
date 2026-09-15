import type { Egress, FetchInit } from '$lib/server/http/egress';
import { blockedHost, EGRESS_BLOCKED_DETAIL } from '$lib/server/http/egress';
import { FORGE_KINDS, type ForgeKind, type ReleaseStatus } from '$lib/shared/deploy';

/**
 * Forge abstraction: everything the hub needs from a git host beyond
 * plain clone. A forge driver knows how to locate the repo's API
 * endpoint and how to post a commit status. Webhook signature
 * verification stays style-based in hook.ts because providers share
 * header conventions; this module handles the outbound direction.
 */

/** Owner/repo coordinates parsed from a clone URL. */
export interface RepoCoords {
	host: string;
	owner: string;
	repo: string;
}

/**
 * Parse a clone url into host + owner/repo. Accepts https and ssh
 * scp-style forms; anything else returns null and statuses are
 * skipped rather than guessed at.
 */
export function parseRepoCoords(url: string): RepoCoords | null {
	// Owner is greedy so nested group paths (gitlab.com/group/sub/repo)
	// land whole; the repo name is the last segment.
	const m =
		/^https?:\/\/([^/]+)\/(.+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url) ??
		/^git@([^:]+):(.+)\/([^/]+?)(?:\.git)?$/i.exec(url);
	if (!m) return null;
	return { host: m[1].toLowerCase(), owner: m[2], repo: m[3] };
}

/**
 * Resolve the forge kind for a repo. An explicit source.forge wins;
 * otherwise detection is by hostname. Self-hosted instances need the
 * explicit override since gitea/gitlab can live on any domain.
 */
export function forgeKind(explicit: string | undefined, coords: RepoCoords | null): ForgeKind {
	if (explicit && (FORGE_KINDS as readonly string[]).includes(explicit)) {
		return explicit as ForgeKind;
	}
	if (!coords) return 'generic';
	if (coords.host === 'github.com') return 'github';
	if (coords.host === 'gitlab.com') return 'gitlab';
	if (/gitea|forgejo/i.test(coords.host)) return 'gitea';
	return 'generic';
}

/** Map our release vocabulary onto each forge's state vocabulary. */
function statusState(kind: ForgeKind, status: ReleaseStatus | 'pending'): string | null {
	switch (kind) {
		case 'github':
		case 'gitea':
			// Gitea/Forgejo accept the github state vocabulary.
			switch (status) {
				case 'pending':
					return 'pending';
				case 'live':
					return 'success';
				case 'failed':
				case 'rolled_back':
					return 'failure';
				default:
					return null; // superseded posts nothing
			}
		case 'gitlab':
			switch (status) {
				case 'pending':
					return 'pending';
				case 'live':
					return 'success';
				case 'failed':
					return 'failure';
				case 'rolled_back':
					return 'canceled';
				default:
					return null;
			}
		default:
			return null;
	}
}

/**
 * Status endpoint + body per forge. Returns null when the forge has
 * no status API (generic) or the repo is not API-addressable.
 */
export function statusRequest(
	kind: ForgeKind,
	coords: RepoCoords,
	sha: string,
	status: ReleaseStatus | 'pending',
	opts: { description: string; targetUrl: string | null }
): { url: string; body: Record<string, unknown>; auth: 'bearer' | 'job-token' } | null {
	const state = statusState(kind, status);
	if (!state) return null;
	const desc = opts.description.slice(0, 140);
	switch (kind) {
		case 'github':
		case 'gitea': {
			const api = coords.host === 'github.com' ? 'api.github.com' : coords.host;
			const base =
				coords.host === 'github.com'
					? `https://${api}/repos/${coords.owner}/${coords.repo}`
					: `https://${coords.host}/api/v1/repos/${coords.owner}/${coords.repo}`;
			return {
				url: `${base}/statuses/${sha}`,
				auth: 'bearer',
				body: {
					state,
					context: 'wharfinger/deploy',
					description: desc,
					...(opts.targetUrl ? { target_url: opts.targetUrl } : {})
				}
			};
		}
		case 'gitlab': {
			const project = encodeURIComponent(`${coords.owner}/${coords.repo}`);
			return {
				url: `https://${coords.host}/api/v4/projects/${project}/statuses/${sha}`,
				auth: 'job-token',
				body: {
					state,
					name: 'wharfinger/deploy',
					description: desc,
					...(opts.targetUrl ? { target_url: opts.targetUrl } : {})
				}
			};
		}
		default:
			return null;
	}
}

/**
 * Branch-list endpoint per forge, for repo browsing in the app form.
 * Returns null when the forge has no list API (generic) or the repo
 * is not API-addressable.
 */
function branchesRequest(
	kind: ForgeKind,
	coords: RepoCoords
): { url: string; auth: 'bearer' | 'job-token' } | null {
	switch (kind) {
		case 'github':
		case 'gitea': {
			const base =
				coords.host === 'github.com'
					? `https://api.github.com/repos/${coords.owner}/${coords.repo}`
					: `https://${coords.host}/api/v1/repos/${coords.owner}/${coords.repo}`;
			return { url: `${base}/branches?per_page=100`, auth: 'bearer' };
		}
		case 'gitlab': {
			const project = encodeURIComponent(`${coords.owner}/${coords.repo}`);
			return {
				url: `https://${coords.host}/api/v4/projects/${project}/repository/branches?per_page=100`,
				auth: 'job-token'
			};
		}
		default:
			return null;
	}
}

/** Read at most max bytes of a response body. */
async function readBounded(res: Response, max: number): Promise<string> {
	const reader = res.body?.getReader();
	if (!reader) return (await res.text()).slice(0, max);
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			total += value.byteLength;
			if (total > max) break;
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	const out = new Uint8Array(Math.min(total, max));
	let off = 0;
	for (const c of chunks) {
		const slice = c.subarray(0, Math.min(c.byteLength, out.byteLength - off));
		out.set(slice, off);
		off += slice.byteLength;
	}
	return new TextDecoder().decode(out);
}

const MAX_FORGE_BODY = 256 * 1024;

/**
 * List branch names for a repo through the egress guard. The app
 * token authorizes private repos; without one the listing still
 * works for public repos. Errors resolve to an error string rather
 * than throwing so the panel can show the cause.
 */
export async function listBranches(
	egress: Egress,
	kind: ForgeKind,
	coords: RepoCoords,
	token: string | null,
	timeoutMs = 5000
): Promise<{ ok: boolean; branches: string[]; error: string | null }> {
	const req = branchesRequest(kind, coords);
	if (!req) return { ok: false, branches: [], error: 'forge has no branch api' };
	try {
		if (!egress.allowLinkLocal() && blockedHost(new URL(req.url).hostname)) {
			return { ok: false, branches: [], error: EGRESS_BLOCKED_DETAIL };
		}
	} catch {
		return { ok: false, branches: [], error: 'repo url is not api-addressable' };
	}
	const headers: Record<string, string> = { accept: 'application/json' };
	if (token) {
		if (req.auth === 'bearer') headers.authorization = `Bearer ${token}`;
		else headers['private-token'] = token;
	}
	try {
		const res = await fetch(req.url, {
			headers,
			signal: AbortSignal.timeout(timeoutMs),
			redirect: 'manual',
			dispatcher: egress.dispatcher
		} as FetchInit);
		const body = await readBounded(res, MAX_FORGE_BODY).catch(() => '');
		if (res.status < 200 || res.status >= 300) {
			return { ok: false, branches: [], error: `HTTP ${res.status}` };
		}
		const parsed = JSON.parse(body) as unknown;
		if (!Array.isArray(parsed)) return { ok: false, branches: [], error: 'unexpected response' };
		const branches = parsed
			.map((b) => (typeof b === 'object' && b !== null ? (b as { name?: unknown }).name : null))
			.filter((n): n is string => typeof n === 'string' && n.length <= 200)
			.slice(0, 100);
		return { ok: true, branches, error: null };
	} catch (err) {
		return { ok: false, branches: [], error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Post a commit status to the forge. Best-effort: failures resolve
 * false and never throw so a forge outage cannot break a deploy
 * settle. Token is a PAT/app token (github/gitea: Authorization
 * bearer; gitlab: PRIVATE-TOKEN). The sha must look like a commit
 * before it lands in a URL path.
 */
export async function postCommitStatus(
	egress: Egress,
	kind: ForgeKind,
	coords: RepoCoords,
	token: string,
	sha: string,
	status: ReleaseStatus | 'pending',
	opts: { description: string; targetUrl: string | null },
	timeoutMs = 5000
): Promise<{ ok: boolean; error: string | null }> {
	if (!/^[0-9a-f]{7,64}$/i.test(sha)) return { ok: false, error: 'invalid sha' };
	const req = statusRequest(kind, coords, sha, status, opts);
	if (!req) return { ok: false, error: 'forge has no status api' };
	try {
		if (!egress.allowLinkLocal() && blockedHost(new URL(req.url).hostname)) {
			return { ok: false, error: EGRESS_BLOCKED_DETAIL };
		}
	} catch {
		return { ok: false, error: 'repo url is not api-addressable' };
	}
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (req.auth === 'bearer') headers.authorization = `Bearer ${token}`;
	else headers['private-token'] = token;
	try {
		const res = await fetch(req.url, {
			method: 'POST',
			headers,
			body: JSON.stringify(req.body),
			signal: AbortSignal.timeout(timeoutMs),
			redirect: 'manual',
			dispatcher: egress.dispatcher
		} as FetchInit);
		await res.arrayBuffer().catch(() => undefined);
		if (res.status >= 200 && res.status < 300) return { ok: true, error: null };
		return { ok: false, error: `HTTP ${res.status}` };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}
