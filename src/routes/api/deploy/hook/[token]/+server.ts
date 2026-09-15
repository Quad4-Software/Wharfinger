import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, readText } from '$lib/server/admin/http';
import { postReleaseStatus, triggerDeploy } from '$lib/server/deploy/trigger';
import { DeployError } from '$lib/server/deploy/store';
import {
	branchMatches,
	hookSignatureOk,
	isPRWebhook,
	parsePREvent,
	parsePush,
	pathsMatch
} from '$lib/server/deploy/hook';
import { closePreview, openPreview } from '$lib/server/deploy/preview';

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
	const app = await rt.deploys.byWebhook(event.params.token);
	if (!app) return apiError(404, 'not found');

	const text = await readText(event.request, MAX_BODY);

	const secret = await rt.deploys.hookSecret(app.id);
	if (secret && !hookSignatureOk(event.request.headers, text, secret)) {
		return apiError(401, 'invalid webhook signature');
	}

	const delivery =
		event.request.headers.get('x-github-delivery') ??
		event.request.headers.get('x-gitlab-event-uuid') ??
		`manual-${Date.now()}`;

	// Pull/merge-request events drive preview apps: open/sync deploys
	// an ephemeral app at the PR head ref, close/merge tears it down.
	// The same signature check above covers them. Actions we do not
	// handle (edited, labeled) must not fall through to push parsing,
	// where a refless event would trigger a main-branch deploy.
	if (isPRWebhook(event.request.headers)) {
		const pr = parsePREvent(event.request.headers, text);
		if (!pr) return apiJson({ ok: true, skipped: 'unhandled pr action' });
		// Previews are opt-in: a PR runs unreviewed code with the
		// app's env and credentials, so apps that did not enable it
		// skip quietly rather than erroring on every PR event.
		if (app.source.previews !== true) {
			return apiJson({ ok: true, skipped: 'previews disabled' });
		}
		try {
			if (pr.action === 'close') {
				const { closed } = await closePreview(rt, app, pr.pr);
				return apiJson({ ok: true, preview: 'closed', pr: pr.pr, closed });
			}
			const out = await openPreview(rt, app, pr, delivery);
			return apiJson({
				ok: true,
				preview: out.app.name,
				pr: pr.pr,
				jobId: out.jobId,
				releaseId: out.releaseId,
				deduped: out.deduped
			});
		} catch (err) {
			if (err instanceof DeployError) return apiError(err.status, err.message);
			throw err;
		}
	}

	const push = text.trim() ? parsePush(text) : { ref: '', commit: null, paths: [] };
	if (!push) return apiError(400, 'expected a JSON body');

	// Branch filter: push events carry refs/heads/<branch>; only the
	// app's configured ref triggers. Non-push events (no ref) and
	// explicit manual-hook calls with no ref still deploy.
	if (app.source.kind === 'git' && !branchMatches(push.ref, app.source.ref ?? 'main')) {
		return apiJson({ ok: true, skipped: `branch ${push.ref} != ${app.source.ref ?? 'main'}` });
	}

	// Monorepo path filters: when the app declares paths, a push that
	// touches nothing matching them does not deploy. Events with no
	// file detail always deploy.
	if (app.source.paths?.length && !pathsMatch(app.source.paths, push.paths)) {
		return apiJson({ ok: true, skipped: 'no touched path matched' });
	}

	const commit = push.commit;

	try {
		const { job, releaseId, deduped } = await triggerDeploy(rt, app, {
			jobKey: `deploy:${app.id}:hook:${delivery.slice(0, 80)}`
		});
		if (deduped) return apiJson({ ok: true, deduped: true, jobId: job.id });
		if (commit && releaseId) {
			await rt.deploys.noteCommit(releaseId, commit);
			// Best-effort pending status on the pushed commit; the
			// terminal state lands via settleDeployJob.
			await postReleaseStatus(rt, app, commit, 'pending');
		}
		return apiJson({ ok: true, jobId: job.id, releaseId });
	} catch (err) {
		if (err instanceof DeployError) return apiError(err.status, err.message);
		throw err;
	}
};
