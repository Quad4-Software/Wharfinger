import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, readJson, requirePerm } from '$lib/server/admin/http';
import { DeployError } from '$lib/server/deploy/store';
import { getScanStore } from '$lib/server/scan/store';
import { fixFor } from '$lib/server/scan/recommend';

const ACTIONS = ['apply', 'dismiss'] as const;

/**
 * Act on a recommendation. apply computes the app patch for the rec
 * kind and pushes it through the normal app update path, so the same
 * validation and audit trail cover autofixes as manual edits.
 */
export const POST: RequestHandler = async (event) => {
	requirePerm(event, 'scan.manage');
	const rt = getRuntime();
	const scans = getScanStore(rt.db);
	const body = await readJson<{ action?: unknown }>(event.request, 8192);
	const action = body.action as (typeof ACTIONS)[number];
	if (!ACTIONS.includes(action)) return apiError(422, 'action must be apply or dismiss');

	const rec = scans.rec(event.params.id);
	if (!rec) return apiError(404, 'recommendation not found');
	if (rec.status !== 'open') return apiError(409, `recommendation is ${rec.status}`);

	if (action === 'dismiss') {
		if (!scans.setStatus(rec.id, 'dismissed')) {
			return apiError(409, 'recommendation is no longer open');
		}
		audit(rt, event, 'scan.rec.dismiss', `app=${rec.appId} rec=${rec.id} kind=${rec.kind}`);
		return apiJson({ ok: true, rec: scans.rec(rec.id) });
	}

	if (!rec.autoFixable) return apiError(409, 'recommendation has no automatic fix');
	const app = rt.deploys.getApp(rec.appId);
	if (!app) return apiError(404, 'app not found');
	const patch = fixFor(rec, app);
	if (!patch) return apiError(409, 'recommendation has no expressible fix');

	const before = JSON.stringify({ source: app.source, healthcheck: app.healthcheck });
	try {
		const updated = rt.deploys.updateApp(app.id, patch);
		if (!scans.setStatus(rec.id, 'applied')) {
			// The patch is idempotent, so a lost race still leaves the
			// app fixed; report the rec state honestly either way.
			return apiError(409, 'recommendation is no longer open');
		}
		const after = JSON.stringify({ source: updated.source, healthcheck: updated.healthcheck });
		audit(
			rt,
			event,
			'deploy.app.autofix',
			`app=${app.id} rec=${rec.id} kind=${rec.kind} before=${before} after=${after}`
		);
		return apiJson({ ok: true, rec: scans.rec(rec.id), app: updated });
	} catch (err) {
		if (err instanceof DeployError) return apiError(err.status, err.message);
		throw err;
	}
};
