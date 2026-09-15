import { randomInt } from 'node:crypto';
import type { Runtime } from '$lib/server/runtime';
import type { DeployApp, PortMap, TeardownSpec } from '$lib/shared/deploy';
import { DeployError } from './store';
import { prHeadRef, type PREvent } from './hook';
import { postReleaseStatus, triggerDeploy } from './trigger';
import { forgeKind, parseRepoCoords } from './forge';

/**
 * Preview TTL: a preview that stops receiving pushes is torn down
 * after this window even if the forge never sends a close event.
 */
export const PREVIEW_TTL_MS = 72 * 3600_000;

/** Previews per parent app; bounds concurrent PR load on one agent. */
export const MAX_PREVIEWS = 8;

// Preview host ports come from a dedicated range so an unlucky pick
// is unlikely to land on a well-known service. Anything in the range
// still fails the docker bind loudly if a foreign process holds it.
const PREVIEW_PORT_MIN = 30000;
const PREVIEW_PORT_MAX = 39999;

const PREVIEW_NAME_MAX = 63;

/** dns-label preview name: <parent>-pr<N>, truncated to fit. */
export function previewName(parent: DeployApp, pr: number): string {
	const suffix = `-pr${pr}`;
	const base = parent.name.slice(0, PREVIEW_NAME_MAX - suffix.length).replace(/-+$/, '');
	return `${base}${suffix}`;
}

/**
 * Preview hostname derived from the parent's first concrete domain:
 * drop the leftmost label and prepend the preview name
 * (app.example.com -> <name>-pr42.example.com). A bare two-label
 * domain yields no preview domain; the deploy still runs and is
 * reachable through its allocated port.
 */
export function previewDomain(parent: DeployApp, name: string): string | null {
	const base = parent.domains.find((d) => !d.startsWith('*.'));
	if (!base) return null;
	const rest = base.split('.').slice(1);
	if (rest.length < 2) return null;
	return `${name}.${rest.join('.')}`;
}

/**
 * Allocate a host port no app on the agent currently claims. Not a
 * reservation: two previews created in the same instant can pick the
 * same port, in which case the loser's container bind fails and the
 * release reports the conflict instead of silently colliding.
 */
async function allocPort(rt: Runtime, agentId: string): Promise<number> {
	const used = await rt.deploys.usedHostPorts(agentId);
	for (let i = 0; i < 32; i++) {
		const p = randomInt(PREVIEW_PORT_MIN, PREVIEW_PORT_MAX);
		if (!used.has(p)) return p;
	}
	throw new DeployError(409, 'no free preview port on the agent range');
}

/**
 * Preview port plan. k8s service ports are virtual per-service, so
 * the parent's mappings carry over unchanged; container runtimes
 * publish on the host, so every mapping gets a fresh port and stays
 * loopback-only. With no parent ports, the healthcheck port becomes
 * the edge upstream when the preview has a domain.
 */
async function previewPorts(rt: Runtime, parent: DeployApp): Promise<PortMap[]> {
	if (parent.runtime === 'k8s') return parent.ports;
	if (parent.ports.length) {
		const out: PortMap[] = [];
		for (const p of parent.ports) {
			out.push({ host: await allocPort(rt, parent.agentId), container: p.container, local: true });
		}
		return out;
	}
	if (parent.healthcheck.port) {
		return [
			{ host: await allocPort(rt, parent.agentId), container: parent.healthcheck.port, local: true }
		];
	}
	return [];
}

/** Enqueue the teardown job and drop the app's rows in one step. */
async function teardown(rt: Runtime, app: DeployApp): Promise<void> {
	const spec: TeardownSpec = {
		appId: app.id,
		runtime: app.runtime,
		...(app.namespace ? { namespace: app.namespace } : {})
	};
	await rt.jobs.enqueue({
		kind: 'teardown',
		target: app.agentId,
		spec,
		// One teardown job per app id: close, sweep, and parent-delete
		// can race to enqueue, and the job_key dedupes them. App ids
		// are never reused, so a stale key cannot suppress a future
		// app's teardown.
		jobKey: `teardown:${app.id}`,
		maxAttempts: 3
	});
	await rt.deploys.deleteApp(app.id);
}

/**
 * Open or refresh the preview for one pull/merge request. The
 * preview app clones the parent's config with the ref pointed at
 * the forge's PR head, so every synchronize push redeploys the new
 * head and refreshes the TTL.
 */
export async function openPreview(
	rt: Runtime,
	parent: DeployApp,
	event: PREvent,
	delivery: string
): Promise<{ app: DeployApp; jobId: number; releaseId: string | null; deduped: boolean }> {
	if (parent.source.kind !== 'git' || !parent.source.url) {
		throw new DeployError(422, 'previews require a git source');
	}
	if (parent.previewOf != null) {
		throw new DeployError(422, 'preview apps cannot spawn previews');
	}
	if (parent.source.previews !== true) {
		throw new DeployError(422, 'PR previews are not enabled for this app');
	}
	let app = await rt.deploys.previewFor(parent.id, event.pr);
	const expiresAt = Date.now() + PREVIEW_TTL_MS;
	if (!app) {
		if ((await rt.deploys.previewsFor(parent.id)).length >= MAX_PREVIEWS) {
			throw new DeployError(429, `preview cap reached (${MAX_PREVIEWS} per app)`);
		}
		const name = previewName(parent, event.pr);
		const domain = previewDomain(parent, name);
		const coords = parseRepoCoords(parent.source.url);
		const kind = coords ? forgeKind(parent.source.forge, coords) : 'generic';
		app = await rt.deploys.createPreviewApp(parent, {
			name,
			pr: event.pr,
			// previews:false strips the opt-in flag so a preview can
			// never spawn its own previews.
			source: { ...parent.source, ref: prHeadRef(kind, event.pr), previews: false },
			domains: domain ? [domain] : [],
			ports: await previewPorts(rt, parent),
			expiresAt
		});
	}
	// Refresh the deadline when the app already existed, whether the
	// caller found it or a racing create returned it.
	if (app.previewExpires == null || app.previewExpires < expiresAt) {
		await rt.deploys.touchPreview(app.id, expiresAt);
	}

	const { job, releaseId, deduped } = await triggerDeploy(rt, app, {
		jobKey: `deploy:${app.id}:pr${event.pr}:${delivery.slice(0, 60)}`
	});
	if (!deduped && event.sha && releaseId) {
		await rt.deploys.noteCommit(releaseId, event.sha);
		await postReleaseStatus(rt, app, event.sha, 'pending');
	}
	return { app, jobId: job.id, releaseId, deduped };
}

/**
 * Tear down the preview for one closed/merged request. Missing
 * preview is a no-op so duplicate close events stay idempotent.
 */
export async function closePreview(
	rt: Runtime,
	parent: DeployApp,
	pr: number
): Promise<{ closed: boolean }> {
	const app = await rt.deploys.previewFor(parent.id, pr);
	if (!app) return { closed: false };
	await teardown(rt, app);
	return { closed: true };
}

/**
 * Tear down every preview under a parent being deleted. Called by
 * the admin delete path before the parent row goes.
 */
export async function closeAllPreviews(rt: Runtime, parentId: string): Promise<number> {
	const previews = await rt.deploys.previewsFor(parentId);
	for (const app of previews) {
		await teardown(rt, app);
	}
	return previews.length;
}

/**
 * TTL sweep, wired into the runtime job tick. Expired previews get
 * the same teardown+delete path as a close event; the job queue is
 * durable so the teardown survives a hub restart.
 */
export async function sweepPreviews(rt: Runtime, now = Date.now()): Promise<number> {
	const expired = await rt.deploys.expiredPreviews(now);
	for (const app of expired) {
		await teardown(rt, app);
	}
	return expired.length;
}
