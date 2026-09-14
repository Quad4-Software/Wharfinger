import type { AppSource, DeployApp, DeploySpec, Healthcheck } from '$lib/shared/deploy';
import type { NewRecommendation, Recommendation, ScanFinding } from '$lib/shared/scan';

// Pure recommendation engine. evaluate() inspects the app record, the
// frozen deploy spec, and a scan's findings, and returns the
// recommendations a fresh scan implies. fixFor() turns an autoFixable
// rec into the deploy app patch that applies it. No IO here; callers
// own persistence and audit.

const DIGEST_RE = /^[a-z0-9][a-z0-9./_-]*@sha256:[0-9a-f]{64}$/i;
const MAX_DETAIL_PKGS = 5;

export interface ScanMeta {
	imageRef?: string;
	repoDigests?: string[];
}

/** Registry name without tag or digest, for repo-digest matching. */
function repoName(ref: string): string {
	const noDigest = ref.split('@')[0];
	const slash = noDigest.lastIndexOf('/');
	const colon = noDigest.lastIndexOf(':');
	return colon > slash ? noDigest.slice(0, colon) : noDigest;
}

/** True when the image ref carries neither a digest nor a pinned tag. */
function unpinned(ref: string): boolean {
	if (ref.includes('@')) return false;
	const slash = ref.lastIndexOf('/');
	const colon = ref.lastIndexOf(':');
	if (colon <= slash) return true; // no tag at all
	return ref.slice(colon + 1) === 'latest';
}

/** Final path segment, so docker hub shorthands match index.docker.io. */
function basename(ref: string): string {
	const name = repoName(ref);
	return name.slice(name.lastIndexOf('/') + 1);
}

function pickDigest(ref: string, digests: string[]): string | null {
	const want = repoName(ref);
	for (const d of digests) {
		if (!DIGEST_RE.test(d)) continue;
		const have = repoName(d);
		if (have === want || have.endsWith(`/${want}`) || want.endsWith(`/${have}`)) return d;
		if (basename(have) === basename(want)) return d;
	}
	return null;
}

function sevRank(f: ScanFinding): number {
	if (f.severity === 'critical') return 0;
	if (f.severity === 'high') return 1;
	if (f.severity === 'medium') return 2;
	if (f.severity === 'low') return 3;
	return 4;
}

/**
 * Evaluate an app plus its latest scan into recommendations. spec may
 * be null when no release has been deployed yet; spec-dependent recs
 * are skipped in that case.
 */
export function evaluate(
	app: DeployApp,
	spec: DeploySpec | null,
	findings: ScanFinding[],
	meta: ScanMeta = {}
): NewRecommendation[] {
	const out: NewRecommendation[] = [];

	if (app.source.kind === 'image' && app.source.url && unpinned(app.source.url)) {
		const digest = pickDigest(app.source.url, meta.repoDigests ?? []);
		out.push({
			kind: 'pin-image-tag',
			dedupeKey: '',
			severity: 'medium',
			title: 'Pin the image to a tag or digest',
			detail: digest
				? `${app.source.url} is unpinned, so pulls can silently drift. Pin to the observed digest ${digest}.`
				: `${app.source.url} is unpinned, so pulls can silently drift. Set a specific tag or digest on the image source.`,
			autoFixable: digest !== null,
			...(digest ? { data: { ref: digest } } : {})
		});
	}

	if (!app.healthcheck.kind || !app.healthcheck.port) {
		const port =
			(app.healthcheck.port ?? 0) > 0 ? app.healthcheck.port : spec?.run.ports[0]?.container;
		out.push({
			kind: 'add-healthcheck',
			dedupeKey: '',
			severity: 'medium',
			title: 'Add a container healthcheck',
			detail:
				'Without a healthcheck a deploy cannot prove the new release is serving before the old one stops, so swaps take the slow path. A tcp check on the app port is enough.',
			autoFixable: Number.isInteger(port) && (port ?? 0) > 0,
			...(port ? { data: { port } } : {})
		});
	}

	if (spec) {
		const run = spec.run as unknown as Record<string, unknown>;
		const user = 'user' in run ? run.user : undefined;
		const rootish =
			user === undefined || user === '' || user === 'root' || user === '0' || user === 0;
		if (rootish) {
			out.push({
				kind: 'run-non-root',
				dedupeKey: '',
				severity: 'low',
				title: 'Run the container as a non-root user',
				detail:
					'The run spec sets no user, so the container uses the image default, which is usually root. Set USER to a non-root account in the Dockerfile, or run.user once the spec supports it.',
				autoFixable: false
			});
		}
	}

	const ports = spec?.run.ports ?? [];
	const domains = spec?.route.domains ?? [];
	if (ports.length > 0 && domains.length > 0) {
		const pairs = ports
			.map((p) => `${p.host}:${p.container}`)
			.sort()
			.slice(0, 16);
		out.push({
			kind: 'unexpose-ports',
			dedupeKey: pairs.join(','),
			severity: 'medium',
			title: 'Remove direct port publishes',
			detail: `Published host ports ${pairs.join(', ')} bypass the routed domain and the edge proxy. Let the route carry traffic and drop the publishes.`,
			// The app update API has no ports field today; the fix has
			// to land on the run spec before this can auto-apply.
			autoFixable: false
		});
	}

	const serious = findings
		.filter((f) => f.severity === 'critical' || f.severity === 'high')
		.sort((a, b) => sevRank(a) - sevRank(b) || a.pkg.localeCompare(b.pkg));
	if (serious.length > 0) {
		const top = serious
			.slice(0, MAX_DETAIL_PKGS)
			.map((f) => `${f.pkg} ${f.vulnId}${f.fixed ? ` (fixed in ${f.fixed})` : ''}`);
		out.push({
			kind: 'upgrade-base-image',
			dedupeKey: '',
			severity: serious.some((f) => f.severity === 'critical') ? 'high' : 'medium',
			title: 'Rebuild on an updated base image',
			detail: `${serious.length} critical or high findings. Most image findings clear by rebuilding on a fresher base. Top offenders: ${top.join('; ')}.`,
			autoFixable: false
		});
	}

	if (spec) {
		const run = spec.run as unknown as Record<string, unknown>;
		// The field does not exist on DeploySpec yet; when it lands
		// this flags apps that leave it unset.
		if ('resources' in run && !run.resources) {
			out.push({
				kind: 'set-resource-limits',
				dedupeKey: '',
				severity: 'low',
				title: 'Set container resource limits',
				detail:
					'The run spec supports resource limits but none are set, so one container can starve the host. Set memory and cpu limits on the app.',
				autoFixable: false
			});
		}
	}

	return out;
}

export interface AppFixPatch {
	source?: AppSource;
	healthcheck?: Healthcheck;
	domains?: string[];
}

/**
 * The deploy app patch that applies an autoFixable rec, or null when
 * the kind has no expressible fix. Callers must 409 on null.
 */
export function fixFor(rec: Recommendation, app: DeployApp): AppFixPatch | null {
	switch (rec.kind) {
		case 'pin-image-tag': {
			if (app.source.kind !== 'image') return null;
			const ref = rec.data?.ref;
			if (typeof ref !== 'string' || !DIGEST_RE.test(ref)) return null;
			return { source: { ...app.source, url: ref } };
		}
		case 'add-healthcheck': {
			const port = rec.data?.port;
			if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
				return null;
			}
			return { healthcheck: { kind: 'tcp', port: port as number } };
		}
		default:
			return null;
	}
}
