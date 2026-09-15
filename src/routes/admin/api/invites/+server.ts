import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, readJson, requirePerm } from '$lib/server/admin/http';
import { canGrantRole } from '$lib/server/admin/authz';

export const GET: RequestHandler = async (event) => {
	const rt = getRuntime();
	requirePerm(event, 'invites.manage');
	const invites = (await rt.invites.recent(100)).map((i) => ({
		hash: i.tokenHash.slice(0, 16),
		kind: i.kind,
		role: i.role,
		createdAt: i.createdAt,
		expiresAt: i.expiresAt,
		usedAt: i.usedAt,
		revokedAt: i.revokedAt,
		expired: i.expiresAt <= Date.now()
	}));
	return apiJson({ invites });
};

/** Create an invite link. The full token is returned exactly once. */
export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const actor = requirePerm(event, 'invites.manage');
	const body = await readJson<{ role?: unknown; ttl_hours?: unknown }>(event.request, 8192);
	if (
		body.role !== undefined &&
		(typeof body.role !== 'string' || !(await rt.roles.exists(body.role)))
	) {
		return apiError(422, 'unknown role');
	}
	// Least privilege: an unspecified role creates an operator invite.
	const role = typeof body.role === 'string' ? body.role : 'operator';
	if (!(await canGrantRole(rt.roles, event.locals.perms, role))) {
		return apiError(403, 'you cannot grant a role with permissions you do not hold');
	}
	const ttlHours =
		typeof body.ttl_hours === 'number' && body.ttl_hours >= 1 && body.ttl_hours <= 720
			? body.ttl_hours
			: rt.config.admin.invite_ttl_hours;

	const { token } = await rt.invites.create({
		kind: 'invite',
		role,
		createdBy: actor.id,
		ttlMs: ttlHours * 3600_000
	});
	await audit(rt, event, 'invites.create', `role=${role} ttl=${ttlHours}h`);
	return apiJson(
		{ url: `${event.url.origin}${rt.adminBase()}/invite/${token}`, expires_in_hours: ttlHours },
		201
	);
};
