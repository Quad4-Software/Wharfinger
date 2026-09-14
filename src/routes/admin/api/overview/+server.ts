import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { can } from '$lib/server/admin/authz';
import { apiJson, requireUser } from '$lib/server/admin/http';

export const GET: RequestHandler = (event) => {
	const rt = getRuntime();
	const user = requireUser(event);
	const { snapshot } = rt.snapshot.current();
	const eff = rt.effective();

	const services = snapshot.groups.flatMap((g) =>
		g.services.map((s) => ({
			id: s.id,
			name: s.name,
			group: g.name,
			status: s.status,
			latencyMs: s.latencyMs,
			lastDetail: s.lastDetail,
			inMaintenance: s.inMaintenance,
			certDays: s.certDays,
			certWarn: s.certWarn
		}))
	);

	return apiJson({
		user,
		generatedAt: snapshot.generatedAt,
		overall: snapshot.overall,
		site: { name: snapshot.site.name, url: snapshot.site.url },
		services,
		incidents: snapshot.incidents,
		maintenance: snapshot.maintenance,
		users: can(rt.roles, user, 'users.manage') ? rt.users.count() : null,
		overrides: can(rt.roles, user, 'admin.settings')
			? [...eff.overrides.entries()].map(([section, o]) => ({
					section,
					updatedAt: o.updatedAt,
					updatedBy: o.updatedBy
				}))
			: [],
		notifications: {
			enabled: rt.config.notifications.enabled,
			targets: rt.config.notifications.targets.length,
			// The delivery log names internal targets and error strings;
			// viewers do not need it on the dashboard.
			recent: can(rt.roles, user, 'status.manage') ? rt.notifyLog.recent(10) : []
		},
		audit: can(rt.roles, user, 'audit.view') ? rt.audit.list({ limit: 10, offset: 0 }).entries : [],
		admin: {
			basePath: rt.adminBase(),
			sessionTtlHours: rt.config.admin.session_ttl_hours,
			inviteTtlHours: rt.config.admin.invite_ttl_hours
		}
	});
};
