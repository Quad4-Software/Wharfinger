import * as v from 'valibot';
import { WEEKDAYS } from '$lib/shared/maintenance';
import { NOTIFY_EVENTS } from '$lib/shared/notify';

export type { NotifyEvent } from '$lib/shared/notify';

const ServiceId = v.pipe(
	v.string(),
	v.regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'service id must be a lowercase slug')
);

const IsoDate = v.pipe(
	v.string(),
	v.check((s) => !Number.isNaN(Date.parse(s)), 'must be an ISO 8601 timestamp')
);

// Only http(s) URLs may reach the page; javascript:/data: would be an
// XSS vector if rendered into href attributes.
const HttpUrl = v.pipe(
	v.string(),
	v.url(),
	v.check((s) => {
		try {
			const p = new URL(s).protocol;
			return p === 'http:' || p === 'https:';
		} catch {
			return false;
		}
	}, 'must be an http or https URL')
);

const HttpService = v.object({
	id: ServiceId,
	name: v.string(),
	group: v.optional(v.string(), 'General'),
	description: v.optional(v.string()),
	type: v.literal('http'),
	url: HttpUrl,
	method: v.optional(v.picklist(['GET', 'HEAD']), 'GET'),
	expected_statuses: v.optional(
		v.array(v.pipe(v.number(), v.integer(), v.minValue(100), v.maxValue(599))),
		[200]
	),
	keyword: v.optional(v.string()),
	keyword_absent: v.optional(v.boolean(), false),
	headers: v.optional(v.record(v.string(), v.string())),
	follow_redirects: v.optional(v.boolean(), true),
	// TLS certificate expiry monitoring for https URLs. Set false to
	// disable, or tune the warn threshold per service.
	cert_check: v.optional(v.boolean(), true),
	cert_warn_days: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
	interval_seconds: v.optional(v.number()),
	timeout_ms: v.optional(v.number()),
	degraded_ms: v.optional(v.number())
});

const TcpService = v.object({
	id: ServiceId,
	name: v.string(),
	group: v.optional(v.string(), 'General'),
	description: v.optional(v.string()),
	type: v.literal('tcp'),
	host: v.string(),
	port: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535)),
	// Wrap the connection in TLS and monitor the certificate.
	tls: v.optional(v.boolean(), false),
	cert_warn_days: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
	interval_seconds: v.optional(v.number()),
	timeout_ms: v.optional(v.number()),
	degraded_ms: v.optional(v.number())
});

// Bare host or IP reachability. Node cannot send ICMP echo without raw
// socket privileges, so this probes a set of TCP ports and reports up
// when any accepts a connection.
const PingService = v.object({
	id: ServiceId,
	name: v.string(),
	group: v.optional(v.string(), 'General'),
	description: v.optional(v.string()),
	type: v.literal('ping'),
	host: v.string(),
	ports: v.optional(
		v.array(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535))),
		[443, 80, 22]
	),
	interval_seconds: v.optional(v.number()),
	timeout_ms: v.optional(v.number()),
	degraded_ms: v.optional(v.number())
});

const DnsService = v.object({
	id: ServiceId,
	name: v.string(),
	group: v.optional(v.string(), 'General'),
	description: v.optional(v.string()),
	type: v.literal('dns'),
	host: v.string(),
	record_type: v.optional(v.picklist(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS']), 'A'),
	interval_seconds: v.optional(v.number()),
	timeout_ms: v.optional(v.number()),
	degraded_ms: v.optional(v.number())
});

// A2S (Source Engine) query over UDP: covers Steam game servers
// (CS2, TF2, Rust, ARK, Valheim, ...). Reports players/max and map.
const A2sService = v.object({
	id: ServiceId,
	name: v.string(),
	group: v.optional(v.string(), 'General'),
	description: v.optional(v.string()),
	type: v.literal('a2s'),
	host: v.string(),
	port: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535)),
	interval_seconds: v.optional(v.number()),
	timeout_ms: v.optional(v.number()),
	degraded_ms: v.optional(v.number())
});

// JSON API assertion: fetch a JSON document and compare a dot-path
// value (e.g. status, data.healthy). When json_value is unset the
// path only has to resolve to a truthy value.
const JsonService = v.object({
	id: ServiceId,
	name: v.string(),
	group: v.optional(v.string(), 'General'),
	description: v.optional(v.string()),
	type: v.literal('json'),
	url: HttpUrl,
	json_path: v.string(),
	json_value: v.optional(v.string()),
	expected_statuses: v.optional(
		v.array(v.pipe(v.number(), v.integer(), v.minValue(100), v.maxValue(599))),
		[200]
	),
	headers: v.optional(v.record(v.string(), v.string())),
	interval_seconds: v.optional(v.number()),
	timeout_ms: v.optional(v.number()),
	degraded_ms: v.optional(v.number())
});

// PostgreSQL wire probe: sends a StartupMessage and treats any valid
// protocol reply (auth request, error, notice) as alive. The check
// never authenticates, so no credentials are needed.
const PostgresService = v.object({
	id: ServiceId,
	name: v.string(),
	group: v.optional(v.string(), 'General'),
	description: v.optional(v.string()),
	type: v.literal('postgres'),
	host: v.string(),
	port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535)), 5432),
	// Sent in the StartupMessage; 'monitor' when unset.
	user: v.optional(v.string()),
	database: v.optional(v.string()),
	interval_seconds: v.optional(v.number()),
	timeout_ms: v.optional(v.number()),
	degraded_ms: v.optional(v.number())
});

// MySQL wire probe: the server speaks first with a handshake packet;
// a well-formed one (or an ERR packet) proves liveness.
const MysqlService = v.object({
	id: ServiceId,
	name: v.string(),
	group: v.optional(v.string(), 'General'),
	description: v.optional(v.string()),
	type: v.literal('mysql'),
	host: v.string(),
	port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535)), 3306),
	interval_seconds: v.optional(v.number()),
	timeout_ms: v.optional(v.number()),
	degraded_ms: v.optional(v.number())
});

// Redis probe: PING, then accept any RESP simple string or error reply
// (-NOAUTH still proves the server is alive).
const RedisService = v.object({
	id: ServiceId,
	name: v.string(),
	group: v.optional(v.string(), 'General'),
	description: v.optional(v.string()),
	type: v.literal('redis'),
	host: v.string(),
	port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535)), 6379),
	interval_seconds: v.optional(v.number()),
	timeout_ms: v.optional(v.number()),
	degraded_ms: v.optional(v.number())
});

const DomainName = v.pipe(
	v.string(),
	v.regex(
		/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i,
		'must be a domain name'
	)
);

// Domain expiry over RDAP: resolves the registry endpoint via the IANA
// bootstrap and degrades the service inside warn_days of expiry.
const RdapService = v.object({
	id: ServiceId,
	name: v.string(),
	group: v.optional(v.string(), 'General'),
	description: v.optional(v.string()),
	type: v.literal('rdap'),
	domain: DomainName,
	warn_days: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(365)), 14),
	interval_seconds: v.optional(v.number()),
	timeout_ms: v.optional(v.number()),
	degraded_ms: v.optional(v.number())
});

// Domain health composite: resolves A/AAAA (down when the name does
// not resolve), watches the :443 cert, scores six security headers on
// https://<domain>/, sweeps a TCP port list (expected_open flags drift
// as degraded), and validates published DANE TLSA records against the
// leaf certificate.
const DomainService = v.object({
	id: ServiceId,
	name: v.string(),
	group: v.optional(v.string(), 'General'),
	description: v.optional(v.string()),
	type: v.literal('domain'),
	domain: DomainName,
	ports: v.optional(
		v.array(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535))),
		[21, 22, 25, 80, 110, 143, 443, 465, 587, 993, 995, 3306, 8080, 8443]
	),
	// When set, any open port outside this list degrades the service.
	expected_open: v.optional(
		v.array(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535)))
	),
	tls: v.optional(v.boolean(), true),
	headers: v.optional(v.boolean(), true),
	dane: v.optional(v.boolean(), true),
	cert_warn_days: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
	interval_seconds: v.optional(v.number()),
	timeout_ms: v.optional(v.number()),
	degraded_ms: v.optional(v.number())
});

// XMPP client-stream probe: opens the stream and waits for
// <stream:features>. tls is direct TLS on connect (e.g. 5223), not
// STARTTLS negotiation.
const XmppService = v.object({
	id: ServiceId,
	name: v.string(),
	group: v.optional(v.string(), 'General'),
	description: v.optional(v.string()),
	type: v.literal('xmpp'),
	host: v.string(),
	port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535)), 5222),
	// Stream 'to' attribute; defaults to host.
	domain: v.optional(v.string()),
	tls: v.optional(v.boolean(), false),
	cert_warn_days: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
	interval_seconds: v.optional(v.number()),
	timeout_ms: v.optional(v.number()),
	degraded_ms: v.optional(v.number())
});

// IRC probe: registers a throwaway nick and waits for the 001 welcome
// numeric; a 433 nick-in-use reply still proves the server speaks IRC.
const IrcService = v.object({
	id: ServiceId,
	name: v.string(),
	group: v.optional(v.string(), 'General'),
	description: v.optional(v.string()),
	type: v.literal('irc'),
	host: v.string(),
	port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535)), 6697),
	tls: v.optional(v.boolean(), true),
	// Random statXXXXXX when unset.
	nick: v.optional(v.string()),
	cert_warn_days: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
	interval_seconds: v.optional(v.number()),
	timeout_ms: v.optional(v.number()),
	degraded_ms: v.optional(v.number())
});

const WsUrl = v.pipe(
	v.string(),
	v.url(),
	v.check((s) => {
		try {
			const p = new URL(s).protocol;
			return p === 'ws:' || p === 'wss:';
		} catch {
			return false;
		}
	}, 'must be a ws or wss URL')
);

// WebSocket probe: completes the HTTP Upgrade handshake (expects 101
// plus a correct Sec-WebSocket-Accept) then closes.
const WebsocketService = v.object({
	id: ServiceId,
	name: v.string(),
	group: v.optional(v.string(), 'General'),
	description: v.optional(v.string()),
	type: v.literal('websocket'),
	url: WsUrl,
	interval_seconds: v.optional(v.number()),
	timeout_ms: v.optional(v.number()),
	degraded_ms: v.optional(v.number())
});

// Dead man's switch: the monitored job calls its unique check-in URL.
// Missing a beat for expected_interval_seconds + grace_seconds flips
// the service down. interval_seconds is the hub's re-evaluation rate.
const PushService = v.object({
	id: ServiceId,
	name: v.string(),
	group: v.optional(v.string(), 'General'),
	description: v.optional(v.string()),
	type: v.literal('push'),
	expected_interval_seconds: v.optional(v.pipe(v.number(), v.minValue(10)), 300),
	grace_seconds: v.optional(v.pipe(v.number(), v.minValue(0)), 60),
	interval_seconds: v.optional(v.number()),
	timeout_ms: v.optional(v.number()),
	degraded_ms: v.optional(v.number())
});

export const Service = v.variant('type', [
	HttpService,
	TcpService,
	DnsService,
	PingService,
	A2sService,
	JsonService,
	PostgresService,
	MysqlService,
	RedisService,
	RdapService,
	DomainService,
	XmppService,
	IrcService,
	WebsocketService,
	PushService
]);

const IncidentUpdate = v.object({
	at: IsoDate,
	message: v.string()
});

const ManualIncident = v.object({
	title: v.string(),
	severity: v.optional(v.picklist(['minor', 'major']), 'minor'),
	services: v.array(ServiceId),
	started_at: IsoDate,
	resolved_at: v.optional(IsoDate),
	updates: v.optional(v.array(IncidentUpdate), [])
});

const ClockTime = v.pipe(
	v.string(),
	v.regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM in 24h time, interpreted as UTC')
);

// One-shot windows use start+end. Recurring windows use weekly+at+
// duration_minutes and expand into concrete occurrences in the snapshot.
const Maintenance = v.pipe(
	v.object({
		// Optional stable identity for admin-managed windows. Public ids in
		// the snapshot prefer this over the positional fallback.
		id: v.optional(
			v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'id must be a lowercase slug'))
		),
		title: v.string(),
		description: v.optional(v.string()),
		services: v.array(v.string()),
		start: v.optional(IsoDate),
		end: v.optional(IsoDate),
		weekly: v.optional(v.picklist(WEEKDAYS)),
		at: v.optional(ClockTime),
		duration_minutes: v.optional(
			v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(7 * 24 * 60))
		)
	}),
	v.check(
		(m) => (m.start !== undefined) === (m.end !== undefined),
		'start and end must be set together'
	),
	v.check(
		(m) =>
			m.weekly !== undefined
				? m.at !== undefined && m.duration_minutes !== undefined
				: m.at === undefined && m.duration_minutes === undefined,
		'weekly maintenance requires at and duration_minutes'
	),
	v.check(
		(m) => (m.start !== undefined) !== (m.weekly !== undefined),
		'set either start+end (one-shot) or weekly+at+duration_minutes (recurring)'
	),
	v.check(
		(m) => m.start === undefined || m.end === undefined || Date.parse(m.end) > Date.parse(m.start),
		'end must be after start'
	)
);

const Link = v.object({
	label: v.string(),
	href: HttpUrl
});

const HexColor = v.pipe(
	v.string(),
	v.regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'must be a hex color')
);

// A named status page served at /p/<slug>, projecting a subset of
// services with optional title/description/accent overrides.
const PageDef = v.object({
	slug: v.pipe(
		v.string(),
		v.regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'page slug must be a lowercase URL slug')
	),
	title: v.string(),
	description: v.optional(v.string()),
	accent: v.optional(HexColor),
	// Keep the page out of search engines (x-robots-tag + meta).
	noindex: v.optional(v.boolean(), false),
	services: v.pipe(v.array(v.string()), v.minLength(1))
});

// Reserved public path prefixes the admin base path must not shadow.
const RESERVED_PREFIXES = [
	'/api',
	'/ingress',
	'/p',
	'/badge',
	'/favicon',
	'/_app',
	'/feed.xml',
	'/robots.txt',
	'/sitemap.xml',
	'/healthz',
	'/favicon.ico'
] as const;

const AdminBasePath = v.pipe(
	v.string(),
	v.regex(/^\/[a-z0-9][a-z0-9-_]*(?:\/[a-z0-9][a-z0-9-_]*)*$/, 'must be a lowercase URL path'),
	v.check(
		(p) => !RESERVED_PREFIXES.some((r) => p === r || p.startsWith(`${r}/`)),
		'must not shadow a reserved route'
	)
);

// Everything about the operator panel. The panel can be fully disabled,
// moved off /admin for stealth, and tuned for brute-force resistance.
const AdminSection = v.object({
	enabled: v.optional(v.boolean(), true),
	// Mount point for the panel + its JSON API. Requests under this path
	// are rewritten internally; the literal /admin route is hidden when
	// this is changed.
	base_path: v.optional(AdminBasePath, '/admin'),
	session_ttl_hours: v.optional(
		v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(720)),
		12
	),
	invite_ttl_hours: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(720)), 72),
	password_min_length: v.optional(
		v.pipe(v.number(), v.integer(), v.minValue(8), v.maxValue(128)),
		12
	),
	login_max_attempts: v.optional(v.pipe(v.number(), v.integer(), v.minValue(2), v.maxValue(50)), 5),
	login_lockout_minutes: v.optional(
		v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1440)),
		15
	),
	// Allow /setup to create the first account while the users table is
	// empty. Disable for invite-only bootstrap flows.
	allow_setup: v.optional(v.boolean(), true),
	// Passkey (WebAuthn) relying-party overrides. Both default to the
	// request origin; set webauthn_origin when the panel is reached
	// through a different public origin, and webauthn_rp_id to a parent
	// domain to share passkeys across subdomains.
	webauthn_origin: v.optional(
		v.pipe(
			HttpUrl,
			v.check((s) => {
				try {
					return new URL(s).origin === s;
				} catch {
					return false;
				}
			}, 'must be an origin (scheme://host[:port], no path)')
		)
	),
	webauthn_rp_id: v.optional(
		v.pipe(
			v.string(),
			v.regex(
				/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/,
				'must be a domain name'
			)
		)
	)
});

const NotifyTarget = v.pipe(
	v.object({
		name: v.pipe(
			v.string(),
			v.regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'target name must be a lowercase slug')
		),
		// ntfy: POST with Title/Priority/Tags/Click headers.
		// unifiedpush: plain-text POST body to the push endpoint.
		// webhook: JSON body POST (generic integrations).
		// slack/discord/teams: incoming-webhook JSON payloads.
		// telegram: Bot API sendMessage with bot_token + chat_id.
		// gotify: POST <url>/message?token=<token> (app token).
		// pushover: POST api.pushover.net with token (api) + user (key).
		type: v.picklist([
			'ntfy',
			'unifiedpush',
			'webhook',
			'slack',
			'discord',
			'teams',
			'telegram',
			'gotify',
			'pushover'
		]),
		// Required for every type except telegram and pushover, whose
		// endpoints are fixed. ${VAR} refs resolve at load like token.
		url: v.optional(HttpUrl),
		// Optional auth. ntfy accepts a bearer token or user:pass; webhook
		// treats this as an Authorization header value verbatim; gotify
		// uses it as the app token; pushover as the api token.
		token: v.optional(v.string()),
		// telegram bot credentials; bot_token may be a ${VAR} ref.
		bot_token: v.optional(v.string()),
		chat_id: v.optional(v.string()),
		// pushover user or group key.
		user: v.optional(v.string()),
		priority: v.optional(
			v.picklist(['min', 'low', 'default', 'high', 'urgent', '1', '2', '3', '4', '5'])
		),
		tags: v.optional(v.array(v.string())),
		click_url: v.optional(HttpUrl),
		headers: v.optional(v.record(v.string(), v.string())),
		events: v.optional(v.array(v.picklist(NOTIFY_EVENTS)), [...NOTIFY_EVENTS]),
		services: v.optional(v.array(v.string()), ['all']),
		enabled: v.optional(v.boolean(), true)
	}),
	v.check(
		(t) => t.type !== 'unifiedpush' || t.token === undefined,
		'unifiedpush endpoints carry their secret in the URL; token is not used'
	),
	v.check(
		(t) => t.url !== undefined || t.type === 'telegram' || t.type === 'pushover',
		'url is required for this target type'
	),
	v.check(
		(t) => t.type !== 'telegram' || (t.bot_token !== undefined && t.chat_id !== undefined),
		'telegram targets require bot_token and chat_id'
	),
	v.check(
		(t) => t.type !== 'gotify' || t.token !== undefined,
		'gotify targets require token (the app token)'
	),
	v.check(
		(t) => t.type !== 'pushover' || (t.token !== undefined && t.user !== undefined),
		'pushover targets require token (api token) and user (user key)'
	)
);

// Error telemetry over the Sentry event protocol. One dsn works for
// Sentry, GlitchTip, and Bugsink; they all accept the same envelope
// endpoint. dsn = "" disables delivery without removing the section.
// [storage] picks the persistence driver. sqlite (default) is the
// embedded node:sqlite store; surreal points at a remote SurrealDB
// over websocket JSON-RPC for fleets that outgrow a single file.
// Boot-time only; not a runtime-editable section.
export const StorageSection = v.object({
	driver: v.optional(v.picklist(['sqlite', 'surreal']), 'sqlite'),
	// ws(s):// or http(s):// host:port; /rpc is appended when absent.
	url: v.optional(v.string(), ''),
	ns: v.optional(v.string(), 'wharfinger'),
	db: v.optional(v.string(), 'wharfinger'),
	user: v.optional(v.string(), ''),
	pass: v.optional(v.string(), ''),
	// per-statement timeout
	timeout_ms: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1000)), 30_000)
});

const TelemetrySection = v.object({
	// Opt-in: a fresh install must not send crash telemetry anywhere
	// until the operator turns it on and chooses a dsn.
	enabled: v.optional(v.boolean(), false),
	dsn: v.optional(
		v.union([v.literal(''), HttpUrl]),
		'https://e4312b8cd18c427c803fb19041285df8@bugs.quad4.io/4'
	),
	environment: v.optional(v.string(), 'production'),
	// Forward browser crashes collected by the error boundary and the
	// client error hook. They relay through /api/telemetry so the dsn
	// and CSP never reach the page.
	client_reports: v.optional(v.boolean(), true),
	// Cap on forwarded events per minute; identical events inside a
	// minute are always collapsed regardless of this limit.
	max_per_minute: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000)), 60)
});

// Remote agent ingest. Agents push host metrics to POST /ingress or
// the ws bridge at /ingress/ws (handled by server.js in production).
export const IngressSection = v.object({
	enabled: v.optional(v.boolean(), true),
	// Payload size cap. Hosts with many containers/services still fit;
	// anything larger is almost certainly malformed.
	max_body_kb: v.optional(v.pipe(v.number(), v.integer(), v.minValue(16), v.maxValue(4096)), 512),
	// How long downsampled agent_samples rows are kept.
	sample_retention_days: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 30),
	// A system counts as online while last_seen is within this window.
	online_seconds: v.optional(v.pipe(v.number(), v.integer(), v.minValue(15), v.maxValue(3600)), 90),
	// Agent alerts through the notify dispatcher. 0 disables each rule.
	// An agent silent for alert_offline_minutes fires a down event and a
	// recovered event when it reports again. Usage thresholds fire a
	// degraded event at >= the value and recover 10 points below it.
	alert_offline_minutes: v.optional(
		v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(10080)),
		10
	),
	alert_cpu_pct: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(100)), 0),
	alert_mem_pct: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(100)), 0),
	alert_disk_pct: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(100)), 0)
});

// External identity: OIDC authorization-code flow (Pocket ID, Authelia,
// Authentik, Keycloak, ...) plus optional LDAP password auth. External
// users are provisioned on first login; roles come from group claims.
const OidcSection = v.object({
	enabled: v.optional(v.boolean(), false),
	issuer: v.optional(HttpUrl, 'https://auth.quad4.io'),
	client_id: v.optional(v.string(), ''),
	// Resolved from ${VAR} at load; never persisted back to the file.
	client_secret: v.optional(v.string(), ''),
	scopes: v.optional(v.string(), 'openid profile email groups'),
	button_label: v.optional(v.string(), 'Sign in with SSO'),
	username_claim: v.optional(v.string(), 'preferred_username'),
	groups_claim: v.optional(v.string(), 'groups'),
	// Members of these groups map to roles. No match falls back to
	// default_role, which accepts any role name from the roles table;
	// 'deny' refuses the login entirely and unknown roles deny at login.
	admin_group: v.optional(v.string(), ''),
	operator_group: v.optional(v.string(), ''),
	default_role: v.optional(v.string(), 'deny'),
	// Re-sync display name and role from claims on every login.
	sync_profile: v.optional(v.boolean(), true)
});

const LdapSection = v.object({
	enabled: v.optional(v.boolean(), false),
	// ldap://host:389 or ldaps://host:636
	url: v.optional(v.string(), ''),
	starttls: v.optional(v.boolean(), false),
	// Direct-bind template, e.g. uid={username},ou=people,dc=example,dc=com
	bind_dn: v.optional(v.string(), ''),
	// Optional service-account search for display name and groups.
	search_bind_dn: v.optional(v.string(), ''),
	search_bind_password: v.optional(v.string(), ''),
	search_base: v.optional(v.string(), ''),
	user_filter: v.optional(v.string(), '(uid={username})'),
	display_attr: v.optional(v.string(), 'cn'),
	// Group DNs granting roles (from the memberOf attribute). default_role
	// accepts any role name from the roles table; 'deny' refuses the login.
	admin_group: v.optional(v.string(), ''),
	operator_group: v.optional(v.string(), ''),
	default_role: v.optional(v.string(), 'deny'),
	timeout_ms: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1000), v.maxValue(30000)), 8000)
});

const NotificationsSection = v.object({
	enabled: v.optional(v.boolean(), true),
	// Minimum seconds between two notifications for the same
	// (target, service, event) tuple. Guards against transition storms.
	cooldown_seconds: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 300),
	timeout_ms: v.optional(v.pipe(v.number(), v.integer(), v.minValue(500), v.maxValue(60000)), 8000),
	retries: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(5)), 1),
	targets: v.optional(
		v.pipe(
			v.array(NotifyTarget),
			v.check((t) => new Set(t.map((x) => x.name)).size === t.length, 'target names must be unique')
		),
		[]
	)
});

const ConfigSchema = v.object({
	site: v.object({
		name: v.string(),
		title: v.optional(v.string()),
		description: v.optional(v.string(), ''),
		url: v.optional(HttpUrl),
		logo_url: v.optional(v.string()),
		accent: v.optional(HexColor, '#10b981'),
		announcement: v.optional(v.string()),
		announcement_severity: v.optional(v.picklist(['info', 'warning', 'critical']), 'info'),
		// Origins allowed to embed the page in an iframe. Each entry is
		// 'self' or a scheme://host[:port] origin; '*' is never valid.
		// Default ['self'] keeps external framing blocked while the
		// admin preview still works.
		frame_ancestors: v.optional(
			v.pipe(
				v.array(
					v.pipe(
						v.string(),
						v.regex(
							/^('self'|https?:\/\/[a-z0-9.-]+(:\d{1,5})?)$/i,
							'expected "self" or an https?://host[:port] origin'
						)
					)
				),
				v.maxLength(20)
			),
			["'self'"]
		)
	}),
	page: v.optional(
		v.object({
			refresh_seconds: v.optional(
				v.pipe(v.number(), v.integer(), v.minValue(5), v.maxValue(3600)),
				30
			),
			history_days: v.optional(v.pipe(v.number(), v.integer(), v.minValue(7), v.maxValue(365)), 90),
			show_uptime_legend: v.optional(v.boolean(), true)
		}),
		{}
	),
	monitor: v.optional(
		v.object({
			concurrency: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(64)), 8),
			user_agent: v.optional(v.string()),
			default_interval_seconds: v.optional(v.pipe(v.number(), v.integer(), v.minValue(5)), 60),
			default_timeout_ms: v.optional(v.pipe(v.number(), v.integer(), v.minValue(250)), 10_000),
			default_degraded_ms: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 1500),
			failure_threshold: v.optional(
				v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10)),
				2
			),
			recovery_threshold: v.optional(
				v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10)),
				2
			),
			retention_days: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 400),
			// TLS certificates expiring within this many days mark the
			// service degraded.
			cert_warn_days: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 14),
			// Outbound checks and notification sends refuse link-local
			// targets by default because that is where cloud metadata
			// endpoints live (SSRF protection). Loopback and RFC1918 stay
			// allowed either way. Enable only to monitor link-local gear.
			allow_link_local: v.optional(v.boolean(), false)
		}),
		{}
	),
	services: v.pipe(
		v.array(Service),
		v.minLength(1),
		v.check(
			(svcs) => new Set(svcs.map((s) => s.id)).size === svcs.length,
			'service ids must be unique'
		)
	),
	incidents: v.optional(v.array(ManualIncident), []),
	maintenance: v.optional(v.array(Maintenance), []),
	pages: v.optional(
		v.pipe(
			v.array(PageDef),
			v.check(
				(pages) => new Set(pages.map((p) => p.slug)).size === pages.length,
				'page slugs must be unique'
			)
		),
		[]
	),
	links: v.optional(v.array(Link), []),
	// SLO targets per service: uptime objective over a rolling window.
	// The snapshot derives error-budget-remaining and burn rate.
	slos: v.optional(
		v.array(
			v.object({
				service: ServiceId,
				target_percent: v.pipe(v.number(), v.minValue(50), v.maxValue(100)),
				window_days: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(90)), 30)
			})
		),
		[]
	),
	admin: v.optional(AdminSection, {}),
	oidc: v.optional(OidcSection, {}),
	ldap: v.optional(LdapSection, {}),
	ingress: v.optional(IngressSection, {}),
	notifications: v.optional(NotificationsSection, {}),
	telemetry: v.optional(TelemetrySection, {}),
	storage: v.optional(StorageSection, {})
});

// Cross-field checks that need the whole document.
export const Config = v.pipe(
	ConfigSchema,
	v.check((cfg) => {
		const ids = new Set(cfg.services.map((s) => s.id));
		return cfg.pages.every((p) => p.services.every((s) => s === 'all' || ids.has(s)));
	}, 'page services must reference defined service ids or "all"'),
	v.check((cfg) => {
		const ids = new Set(cfg.services.map((s) => s.id));
		return cfg.maintenance.every((m) => m.services.every((s) => s === 'all' || ids.has(s)));
	}, 'maintenance services must reference defined service ids or "all"'),
	v.check((cfg) => {
		const ids = new Set(cfg.services.map((s) => s.id));
		return cfg.incidents.every((i) => i.services.every((s) => s === 'all' || ids.has(s)));
	}, 'incident services must reference defined service ids or "all"'),
	v.check((cfg) => {
		const ids = new Set(cfg.services.map((s) => s.id));
		return (
			cfg.slos.every((s) => ids.has(s.service)) &&
			new Set(cfg.slos.map((s) => s.service)).size === cfg.slos.length
		);
	}, 'slos must reference defined service ids, once each'),
	v.check((cfg) => {
		const ids = new Set(cfg.services.map((s) => s.id));
		return cfg.notifications.targets.every((t) =>
			// agent:<id> pins a target to one monitored system's alerts.
			t.services.every((s) => s === 'all' || ids.has(s) || s.startsWith('agent:'))
		);
	}, 'notification target services must reference defined service ids, "all", or agent:<id>')
);

export type StatusConfig = v.InferOutput<typeof Config>;
export type ServiceConfig = StatusConfig['services'][number];
export type NotifyTargetConfig = StatusConfig['notifications']['targets'][number];

// Top-level section keys that the admin panel can override at runtime.
export const SECTION_KEYS = [
	'site',
	'page',
	'monitor',
	'services',
	'incidents',
	'maintenance',
	'pages',
	'links',
	'slos',
	'admin',
	'oidc',
	'ldap',
	'ingress',
	'notifications',
	'telemetry'
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];
