import {
	Activity,
	Bell,
	Bug,
	CalendarClock,
	Flag,
	KeyRound,
	Link2,
	LogIn,
	LogOut,
	MessageSquare,
	MonitorSmartphone,
	Rocket,
	Server,
	Settings2,
	ShieldAlert,
	ShieldCheck,
	TriangleAlert,
	UserRound,
	Users
} from '@lucide/svelte';
import type { Component } from 'svelte';

// Shared audit-action classification for the activity feed and the audit
// log page. ok = creates/enables/resolves (up-green), accent = sign-ins,
// warn = disables/resets/security signals (degraded-amber), bad =
// deletes/revokes/failures (down-red), info = neutral.
export type AuditKind = 'ok' | 'warn' | 'bad' | 'info' | 'accent';

export interface ActionInfo {
	label: string;
	kind: AuditKind;
}

// Humanize audit action names; unknown actions keep the raw dotted form
// so nothing is hidden from admins. A trailing .fail or .denied forces
// kind=bad and marks the label regardless of the base mapping.
export function describeAction(action: string): ActionInfo {
	const fail = action.endsWith('.fail') || action.endsWith('.denied');
	const base = fail ? action.slice(0, action.lastIndexOf('.')) : action;
	const hit = ACTION_MAP[base];
	if (hit)
		return { label: fail ? `${hit.label} (failed)` : hit.label, kind: fail ? 'bad' : hit.kind };
	return { label: action, kind: fail ? 'bad' : 'info' };
}

export function iconForAction(action: string): Component {
	if (action.includes('lockout') || action.endsWith('.fail') || action.endsWith('.denied'))
		return ShieldAlert;
	if (action.includes('logout')) return LogOut;
	if (action.includes('login')) return LogIn;
	if (action.startsWith('auth.') || action.startsWith('account.')) return KeyRound;
	if (action.startsWith('users.session') || action.startsWith('users.sessions'))
		return MonitorSmartphone;
	if (action.startsWith('users.')) return UserRound;
	if (action.startsWith('roles.')) return Users;
	if (action.startsWith('agents.') || action.startsWith('agent.')) return Server;
	if (action.startsWith('apikeys.')) return KeyRound;
	if (action.startsWith('config.')) return Settings2;
	if (action.startsWith('incident')) return TriangleAlert;
	if (action.startsWith('invites.')) return Link2;
	if (action.startsWith('maintenance.')) return CalendarClock;
	if (action.startsWith('markers.')) return Flag;
	if (action.startsWith('notify') || action.startsWith('subscribers.')) return Bell;
	if (action.startsWith('telemetry.')) return Bug;
	if (action.startsWith('deploy.') || action.startsWith('scan.')) return Rocket;
	if (action.startsWith('anomaly.')) return TriangleAlert;
	if (action.startsWith('group.') || action.startsWith('team.')) return Users;
	if (action.startsWith('secrets.')) return KeyRound;
	if (action.startsWith('chat.')) return MessageSquare;
	if (action === 'admin.bootstrap' || action === 'admin.setup') return ShieldCheck;
	return Activity;
}

const ACTION_MAP: Partial<Record<string, ActionInfo>> = {
	'auth.login': { label: 'Signed in', kind: 'accent' },
	'auth.logout': { label: 'Signed out', kind: 'info' },
	'auth.login.disabled': { label: 'Sign-in blocked: account disabled', kind: 'warn' },
	'auth.totp': { label: 'Completed 2FA challenge', kind: 'accent' },
	'auth.oidc': { label: 'Signed in via OIDC', kind: 'accent' },
	'auth.oidc.login': { label: 'Signed in via OIDC', kind: 'accent' },
	'auth.oidc.disabled': { label: 'OIDC sign-in blocked: account disabled', kind: 'warn' },
	'auth.password_reset': { label: 'Reset a password via link', kind: 'info' },
	'auth.invite_accept': { label: 'Accepted an invite', kind: 'ok' },
	'auth.lockout': { label: 'Sign-in locked out', kind: 'warn' },
	'admin.bootstrap': { label: 'Bootstrapped the admin account', kind: 'info' },
	'admin.setup': { label: 'Completed initial setup', kind: 'info' },
	'account.rename': { label: 'Changed display name', kind: 'info' },
	'account.password': { label: 'Changed password', kind: 'info' },
	'account.totp.enable': { label: 'Enabled 2FA', kind: 'ok' },
	'account.totp.disable': { label: 'Disabled 2FA', kind: 'warn' },
	'account.session.revoke': { label: 'Signed out a session', kind: 'warn' },
	'account.session.revoke_all': { label: 'Signed out other sessions', kind: 'warn' },
	'account.avatar': { label: 'Changed avatar', kind: 'info' },
	'account.avatar.remove': { label: 'Removed avatar', kind: 'bad' },
	'account.passkey.add': { label: 'Registered a passkey', kind: 'ok' },
	'account.passkey.rename': { label: 'Renamed a passkey', kind: 'info' },
	'account.passkey.remove': { label: 'Removed a passkey', kind: 'bad' },
	'account.passkey.cloned': { label: 'Possible cloned passkey detected', kind: 'warn' },
	'agents.create': { label: 'Registered a system', kind: 'ok' },
	'agents.rotate': { label: 'Rotated an agent token', kind: 'info' },
	'agents.rotate_hub_key': { label: 'Rotated the hub signing key', kind: 'warn' },
	'agents.rename': { label: 'Renamed a system', kind: 'info' },
	'agents.delete': { label: 'Deleted an agent', kind: 'bad' },
	'agents.revoke': { label: 'Revoked a system', kind: 'bad' },
	'agent.release.upload': { label: 'Uploaded an agent release', kind: 'ok' },
	'agent.release.delete': { label: 'Deleted an agent release', kind: 'bad' },
	'apikeys.create': { label: 'Created an API key', kind: 'ok' },
	'apikeys.toggle': { label: 'Toggled an API key', kind: 'warn' },
	'apikeys.delete': { label: 'Deleted an API key', kind: 'bad' },
	'config.section.save': { label: 'Updated configuration', kind: 'info' },
	'config.toml.save': { label: 'Saved raw config', kind: 'info' },
	'config.section.reset': { label: 'Reset a config section', kind: 'warn' },
	'config.backup.import': { label: 'Imported a config backup', kind: 'warn' },
	'config.update': { label: 'Updated configuration', kind: 'info' },
	'config.reset': { label: 'Reset a config section', kind: 'warn' },
	'incident.create': { label: 'Opened an incident', kind: 'warn' },
	'incident.update': { label: 'Updated an incident', kind: 'info' },
	'incident.resolve': { label: 'Resolved an incident', kind: 'ok' },
	'incidents.create': { label: 'Opened an incident', kind: 'warn' },
	'incidents.update': { label: 'Updated an incident', kind: 'info' },
	'incidents.resolve': { label: 'Resolved an incident', kind: 'ok' },
	'incidents.delete': { label: 'Deleted an incident', kind: 'bad' },
	'invites.create': { label: 'Created an invite link', kind: 'ok' },
	'invites.revoke': { label: 'Revoked an invite', kind: 'bad' },
	'maintenance.create': { label: 'Scheduled maintenance', kind: 'info' },
	'maintenance.delete': { label: 'Cancelled maintenance', kind: 'bad' },
	'markers.create': { label: 'Added a deployment marker', kind: 'info' },
	'markers.delete': { label: 'Deleted a deployment marker', kind: 'bad' },
	'deploy.app.create': { label: 'Created a deploy app', kind: 'ok' },
	'deploy.app.update': { label: 'Updated a deploy app', kind: 'info' },
	'deploy.app.delete': { label: 'Deleted a deploy app', kind: 'bad' },
	'deploy.app.env': { label: 'Changed app environment', kind: 'warn' },
	'deploy.app.autofix': { label: 'Applied a security fix', kind: 'ok' },
	'deploy.key.rotate': { label: 'Rotated a deploy key', kind: 'warn' },
	'deploy.webhook.rotate': { label: 'Rotated a webhook', kind: 'warn' },
	'deploy.trigger': { label: 'Triggered a deploy', kind: 'info' },
	'deploy.rollback': { label: 'Triggered a rollback', kind: 'warn' },
	'scan.run': { label: 'Started an image scan', kind: 'info' },
	'scan.rec.dismiss': { label: 'Dismissed a recommendation', kind: 'info' },
	'anomaly.ack': { label: 'Acknowledged an anomaly', kind: 'info' },
	'group.create': { label: 'Created a group', kind: 'ok' },
	'group.update': { label: 'Updated a group', kind: 'info' },
	'group.delete': { label: 'Deleted a group', kind: 'bad' },
	'group.members': { label: 'Changed group members', kind: 'info' },
	'team.create': { label: 'Created a team', kind: 'ok' },
	'team.update': { label: 'Updated a team', kind: 'info' },
	'team.delete': { label: 'Deleted a team', kind: 'bad' },
	'team.members': { label: 'Changed team members', kind: 'info' },
	'team.groups': { label: 'Changed team groups', kind: 'info' },
	'secrets.create': { label: 'Created a secret set', kind: 'ok' },
	'secrets.update': { label: 'Updated a secret set', kind: 'warn' },
	'secrets.delete': { label: 'Deleted a secret set', kind: 'bad' },
	'secrets.reveal': { label: 'Revealed a secret', kind: 'warn' },
	'notifications.test': { label: 'Sent a test notification', kind: 'info' },
	'notify.target': { label: 'Changed notification targets', kind: 'info' },
	'notify.test': { label: 'Sent a test notification', kind: 'info' },
	'roles.create': { label: 'Created a role', kind: 'ok' },
	'roles.update': { label: 'Updated a role', kind: 'warn' },
	'roles.delete': { label: 'Deleted a role', kind: 'bad' },
	'services.check': { label: 'Ran a manual check', kind: 'info' },
	'subscribers.delete': { label: 'Removed a webhook subscriber', kind: 'bad' },
	'telemetry.test': { label: 'Sent a telemetry test event', kind: 'info' },
	'telemetry.project.create': { label: 'Created a telemetry project', kind: 'ok' },
	'telemetry.project.toggle': { label: 'Toggled a telemetry project', kind: 'warn' },
	'telemetry.project.delete': { label: 'Deleted a telemetry project', kind: 'bad' },
	'telemetry.issue.resolve': { label: 'Changed issue resolution', kind: 'info' },
	'users.create': { label: 'Created a user', kind: 'ok' },
	'users.invite': { label: 'Invited a user', kind: 'info' },
	'users.rename': { label: 'Renamed a user', kind: 'info' },
	'users.role': { label: 'Changed a user role', kind: 'warn' },
	'users.disable': { label: 'Disabled a user', kind: 'warn' },
	'users.enable': { label: 'Enabled a user', kind: 'ok' },
	'users.delete': { label: 'Deleted a user', kind: 'bad' },
	'users.reset_link': { label: 'Created a password reset link', kind: 'info' },
	'users.avatar.remove': { label: 'Removed a user avatar', kind: 'bad' },
	'users.sessions.view': { label: 'Viewed user sessions', kind: 'info' },
	'users.session.revoke': { label: 'Revoked a user session', kind: 'bad' },
	'users.session.revoke_all': { label: 'Revoked all user sessions', kind: 'bad' }
};
