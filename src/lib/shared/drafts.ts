// Raw, snake_case config drafts edited by the admin panel. They mirror
// the TOML shapes so a draft can be saved straight into its config
// section without a conversion layer.

export interface ServiceDraft {
	id: string;
	name: string;
	group: string;
	description?: string;
	type:
		| 'http'
		| 'tcp'
		| 'ping'
		| 'dns'
		| 'a2s'
		| 'json'
		| 'postgres'
		| 'mysql'
		| 'redis'
		| 'rdap'
		| 'domain'
		| 'xmpp'
		| 'irc'
		| 'websocket'
		| 'push'
		| 'security';
	[key: string]: unknown;
}

// Sub-check names for the security service type, shared between the
// config schema picklist, the checker defaults, and the editor chips.
export const SECURITY_CHECKS = [
	'headers',
	'tls',
	'cookies',
	'redirects',
	'mixed-content',
	'security-txt',
	'server-disclosure'
] as const;

export type SecurityCheckName = (typeof SECURITY_CHECKS)[number];

export const SECURITY_CHECK_LABELS: Record<SecurityCheckName, string> = {
	headers: 'Security headers',
	tls: 'TLS certificate',
	cookies: 'Cookie flags',
	redirects: 'Redirect chain',
	'mixed-content': 'Mixed content',
	'security-txt': 'security.txt',
	'server-disclosure': 'Server disclosure'
};

export interface MaintDraft {
	id?: string;
	title: string;
	description?: string;
	services: string[];
	start?: string;
	end?: string;
	weekly?: string;
	at?: string;
	duration_minutes?: number;
	[key: string]: unknown;
}

export interface PageDraft {
	slug: string;
	title: string;
	description?: string;
	accent?: string;
	noindex?: boolean;
	services: string[];
	[key: string]: unknown;
}

export interface TargetDraft {
	name: string;
	type:
		| 'ntfy'
		| 'unifiedpush'
		| 'webhook'
		| 'slack'
		| 'discord'
		| 'teams'
		| 'telegram'
		| 'gotify'
		| 'pushover';
	url?: string;
	token?: string;
	bot_token?: string;
	chat_id?: string;
	user?: string;
	priority?: string;
	tags?: string[];
	click_url?: string;
	headers?: Record<string, string>;
	events: string[];
	services: string[];
	enabled: boolean;
	[key: string]: unknown;
}
