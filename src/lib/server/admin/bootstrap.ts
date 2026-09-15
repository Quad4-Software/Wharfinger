import { USERNAME_RE, checkPassword } from './policy';
import type { AuditStore } from './audit';
import type { UserStore } from './users';

/**
 * Environment-based panel controls for operators who manage the app
 * without a UI:
 *
 *   WHARFINGER_ADMIN_ENABLED=false   hard kill switch for the whole panel;
 *                                wins over wharfinger.toml and runtime
 *                                overrides so it cannot be re-enabled
 *                                from inside the panel
 *   WHARFINGER_ADMIN_USERNAME +
 *   WHARFINGER_ADMIN_PASSWORD        bootstrap the first admin when the
 *   WHARFINGER_ADMIN_DISPLAY_NAME    users table is empty (non-interactive
 *                                alternative to /setup)
 */

export type BootstrapResult = 'created' | 'exists' | 'unset' | 'incomplete' | 'invalid';

export function adminEnvDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.WHARFINGER_ADMIN_ENABLED;
	return v !== undefined && ['0', 'false', 'no', 'off'].includes(v.trim().toLowerCase());
}

/**
 * Create the first admin from env credentials. Only ever runs while the
 * users table is empty, so existing installs are never touched and the
 * account cannot be overwritten by a later env change.
 */
export async function bootstrapAdmin(
	users: UserStore,
	audit: AuditStore,
	env: NodeJS.ProcessEnv = process.env,
	minPasswordLength = 12
): Promise<BootstrapResult> {
	if ((await users.count()) > 0) return 'exists';
	const username = env.WHARFINGER_ADMIN_USERNAME?.trim() ?? '';
	const password = env.WHARFINGER_ADMIN_PASSWORD ?? '';
	if (!username && !password) return 'unset';
	if (!username || !password) return 'incomplete';
	if (!USERNAME_RE.test(username)) return 'invalid';
	if (checkPassword(password, username, minPasswordLength)) return 'invalid';
	const displayName = env.WHARFINGER_ADMIN_DISPLAY_NAME?.slice(0, 80) ?? '';
	const user = await users.create(username, password, 'admin', displayName);
	await audit.log({
		userId: user.id,
		username,
		action: 'admin.bootstrap',
		detail: 'via WHARFINGER_ADMIN_* env'
	});
	return 'created';
}
