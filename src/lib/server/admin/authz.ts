import type { User } from './users';
import type { RoleStore } from './roles';
import type { SectionKey } from '$lib/server/config/schema';

/**
 * Permission model. Role names map to permission sets in the roles
 * table; RoleStore is the single source consulted here and by
 * hooks.server.ts when it resolves a session. The admin role always
 * holds every permission regardless of its stored row.
 */
export type Permission =
	| 'status.view'
	| 'status.manage'
	| 'agents.manage'
	| 'notifications.test'
	| 'admin.settings'
	| 'users.manage'
	| 'invites.manage'
	| 'roles.manage'
	| 'audit.view'
	| 'telemetry.view'
	| 'telemetry.manage'
	| 'deploy.view'
	| 'deploy.manage'
	| 'scan.view'
	| 'scan.manage'
	| 'anomaly.view'
	| 'groups.manage'
	| 'teams.manage'
	| 'secrets.manage'
	| 'config.raw'
	| 'ai.use';

export const ALL_PERMISSIONS: readonly Permission[] = [
	'status.view',
	'status.manage',
	'agents.manage',
	'notifications.test',
	'admin.settings',
	'users.manage',
	'invites.manage',
	'roles.manage',
	'audit.view',
	'telemetry.view',
	'telemetry.manage',
	'deploy.view',
	'deploy.manage',
	'scan.view',
	'scan.manage',
	'anomaly.view',
	'groups.manage',
	'teams.manage',
	'secrets.manage',
	'config.raw',
	'ai.use'
];

const PERM_SET: ReadonlySet<string> = new Set(ALL_PERMISSIONS);

export function isPermission(v: unknown): v is Permission {
	return typeof v === 'string' && PERM_SET.has(v);
}

export async function can(roles: RoleStore, user: User, perm: Permission): Promise<boolean> {
	return (await roles.permsFor(user.role)).has(perm);
}

/**
 * An actor may only assign a role whose permissions they already hold.
 * Without this, any users.manage or invites.manage holder could mint
 * an admin account and the granular role model collapses.
 */
export async function canGrantRole(
	roles: RoleStore,
	actorPerms: ReadonlySet<Permission> | null,
	role: string
): Promise<boolean> {
	if (!actorPerms || !(await roles.exists(role))) return false;
	for (const p of await roles.permsFor(role)) {
		if (!actorPerms.has(p)) return false;
	}
	return true;
}

/** Which permission a config section requires to write. */
export function sectionPermission(section: SectionKey): Permission {
	// The admin section controls panel access, oidc/ldap control
	// authentication, telemetry controls where crash data is sent, and
	// ingress opens a write path into the db; all stay admin-only.
	return ['admin', 'oidc', 'ldap', 'telemetry', 'ingress', 'ai'].includes(section)
		? 'admin.settings'
		: 'status.manage';
}

/**
 * Which permission a config section requires to read. Sections carry
 * secret material (webhook URLs, check Authorization headers, notifier
 * tokens), so reads sit at the same tier as writes: a viewer must not
 * be able to pull raw config the write gate would protect.
 */
export function sectionReadPermission(section: SectionKey): Permission {
	return sectionPermission(section);
}
