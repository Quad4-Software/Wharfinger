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
		| 'push';
	[key: string]: unknown;
}

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
