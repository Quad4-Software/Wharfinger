import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson } from '$lib/server/admin/http';
import { triggerDeploy } from '$lib/server/deploy/trigger';
import { DeployError } from '$lib/server/deploy/store';
import { branchMatches, hookSignatureOk, parsePush } from '$lib/server/deploy/hook';

const MAX_BODY = 256 * 1024;

/**
 * Per-app deploy webhook. The URL token identifies the app (hash
 * lookup); when the app also has a hook secret configured, the
 * provider signature is verified on top: GitHub X-Hub-Signature-256,
 * GitLab X-Gitlab-Token, or a plain X-Quad4-Secret header for custom
 * forges.
 */
export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const app = rt.deploys.byWebhook(event.params.token);
	if (!app) return apiError(404, 'not found');

	const text = await event.request.text();
	if (text.length > MAX_BODY) return apiError(413, 'body too large');

	const secret = rt.deploys.hookSecret(app.id);
	if (secret && !hookSignatureOk(event.request.headers, text, secret)) {
		return apiError(401, 'invalid webhook signature');
	}

	const push = text.trim() ? parsePush(text) : { ref: '', commit: null };
	if (!push) return apiError(400, 'expected a JSON body');

	// Branch filter: push events carry refs/heads/<branch>; only the
	// app's configured ref triggers. Non-push events (no ref) and
	// explicit manual-hook calls with no ref still deploy.
	if (app.source.kind === 'git' && !branchMatches(push.ref, app.source.ref ?? 'main')) {
		return apiJson({ ok: true, skipped: `branch ${push.ref} != ${app.source.ref ?? 'main'}` });
	}

	const delivery =
		event.request.headers.get('x-github-delivery') ??
		event.request.headers.get('x-gitlab-event-uuid') ??
		`manual-${Date.now()}`;
	const commit = push.commit;

	try {
		const { job, releaseId, deduped } = triggerDeploy(rt, app, {
			jobKey: `deploy:${app.id}:hook:${delivery.slice(0, 80)}`
		});
		if (deduped) return apiJson({ ok: true, deduped: true, jobId: job.id });
		if (commit && releaseId) rt.deploys.noteCommit(releaseId, commit);
		return apiJson({ ok: true, jobId: job.id, releaseId });
	} catch (err) {
		if (err instanceof DeployError) return apiError(err.status, err.message);
		throw err;
	}
};
