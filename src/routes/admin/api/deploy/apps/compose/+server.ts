import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, readJson, requirePerm } from '$lib/server/admin/http';
import { parseCompose } from '$lib/server/deploy/compose';
import type { Healthcheck } from '$lib/shared/deploy';
import { DeployError } from '$lib/server/deploy/store';
import { getGroupStore, GroupError } from '$lib/server/groups/store';

interface Body {
	compose?: unknown;
	agentId?: unknown;
	project?: unknown;
	preview?: unknown;
}

/**
 * Import a compose file as linked deploy apps. The plan is always
 * returned so the caller can show what translated and what did not;
 * without `preview`, every service must convert cleanly or nothing
 * is created (all-or-nothing keeps partial stacks out of the panel).
 */
export const POST: RequestHandler = async (event) => {
	requirePerm(event, 'deploy.manage');
	const rt = getRuntime();
	const body = await readJson<Body>(event.request, 256 * 1024);
	const text = typeof body.compose === 'string' ? body.compose : '';
	if (!text.trim()) return apiError(422, 'compose yaml required');
	const agentId = typeof body.agentId === 'string' ? body.agentId : '';
	if (!(await rt.agents.get(agentId))) return apiError(422, 'target agent not found');
	const project =
		typeof body.project === 'string' && body.project.trim()
			? body.project.trim().toLowerCase()
			: '';

	const plan = parseCompose(text);
	if (project) plan.project = project;
	if (plan.services.length === 0) {
		return apiError(422, `no convertible services: ${plan.warnings.join('; ') || 'empty file'}`);
	}
	if (body.preview === true) return apiJson({ ok: true, plan });
	const failed = plan.services.filter((s) => s.error);
	if (failed.length > 0) {
		return apiError(
			422,
			`${failed.length} service(s) cannot convert: ${failed.map((s) => s.name).join(', ')}`,
			{
				plan
			}
		);
	}

	// Create every app; on any store failure the earlier rows are
	// deleted so the import never leaves a half-applied stack.
	const created: { id: string; name: string }[] = [];
	try {
		for (const svc of plan.services) {
			const name = plan.project ? `${plan.project}-${svc.name}` : svc.name;
			const { app } = await rt.deploys.createApp({
				name,
				agentId,
				source: svc.source,
				ports: svc.ports,
				healthcheck: svc.healthcheck.kind ? (svc.healthcheck as Healthcheck) : undefined
			});
			if (Object.keys(svc.env).length > 0) await rt.deploys.setEnv(app.id, svc.env);
			created.push({ id: app.id, name: app.name });
		}
	} catch (err) {
		for (const c of created) await rt.deploys.deleteApp(c.id);
		if (err instanceof DeployError) return apiError(err.status, err.message, { plan });
		throw err;
	}

	// The shared group is the link between the imported services;
	// a name collision reuses the existing group.
	let group: { id: string; name: string } | null = null;
	if (plan.project) {
		const groups = getGroupStore(rt.db);
		try {
			group = await groups.create(plan.project);
		} catch (err) {
			if (err instanceof GroupError && err.status === 409) {
				group = (await groups.list()).find((g) => g.name === plan.project) ?? null;
			} else {
				throw err;
			}
		}
		if (group) {
			await groups.setMembers(
				group.id,
				created.map((c) => ({ memberKind: 'app' as const, memberId: c.id })),
				[]
			);
		}
	}
	await audit(
		rt,
		event,
		'deploy.compose.import',
		`project=${plan.project || 'none'} apps=${created.length}`
	);
	return apiJson({ ok: true, plan, apps: created, group }, 201);
};
