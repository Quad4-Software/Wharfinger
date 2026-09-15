import type { PublicUser, Role } from '$lib/shared/auth';
import type { RoleStore } from './roles';
import type { UserStore } from './users';

export interface GroupRoleConfig {
	admin_group: string;
	operator_group: string;
	// Any role name from the roles table, or 'deny' to refuse the login.
	default_role: string;
}

/** Map IdP group membership to a panel role, or null to deny. */
export function roleFromGroups(groups: string[], cfg: GroupRoleConfig): Role | null {
	const lower = new Set(groups.map((g) => g.toLowerCase()));
	if (cfg.admin_group && lower.has(cfg.admin_group.toLowerCase())) return 'admin';
	if (cfg.operator_group && lower.has(cfg.operator_group.toLowerCase())) return 'operator';
	return cfg.default_role === 'deny' ? null : cfg.default_role;
}

const warnedRoles = new Set<string>();

/**
 * Check a resolved role against the roles table at login time. Unknown
 * roles deny the login; each name warns once so a stale config does
 * not spam the log on every attempt.
 */
export async function knownRole(roles: RoleStore, role: Role): Promise<Role | null> {
	if (await roles.exists(role)) return role;
	if (!warnedRoles.has(role)) {
		warnedRoles.add(role);
		console.warn(`[auth] external login mapped to unknown role "${role}"; denying`);
	}
	return null;
}

/**
 * Resolve or provision an externally-authenticated user. External
 * identity is keyed on (source, external_id); a username collision with
 * a local account never adopts that account, it only renames the
 * external one. Returns null when the account is disabled.
 */
export async function resolveExternalUser(
	users: UserStore,
	source: string,
	externalId: string,
	username: string,
	displayName: string,
	role: Role,
	sync: boolean
): Promise<PublicUser | null> {
	const existing = await users.rowByExternal(source, externalId);
	if (existing) {
		let nextRole = role;
		if (sync && existing.role === 'admin' && role !== 'admin') {
			// An IdP group rename must not lock the panel: keep the last
			// enabled admin at admin and warn instead of sync-demoting.
			const others = (await users.admins()).filter(
				(a) => a.id !== existing.id && a.disabledAt === null
			);
			if (others.length === 0) {
				console.warn(
					`[auth] external sync would demote the last admin "${existing.username}"; keeping admin role`
				);
				nextRole = 'admin';
			}
		}
		if (sync) await users.syncExternal(existing.id, displayName, nextRole);
		const u = await users.byId(existing.id);
		return u?.disabledAt === null ? u : null;
	}
	let uname = username.slice(0, 64) || `${source}-user`;
	for (let i = 0; i < 10 && (await users.rowByName(uname)); i++) {
		uname = `${username.slice(0, 48)}@${source}${i ? `-${i}` : ''}`;
	}
	if (await users.rowByName(uname)) uname = `${source}-${Date.now().toString(36)}`;
	return users.createExternal(uname, displayName, role, source, externalId);
}
