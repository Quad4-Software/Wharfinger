import { chmodSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { AUDIT_GENESIS, auditRowHash, type AuditHashRow } from '../admin/audit';
import { StorageSection } from '../config/schema';
import { SqliteDb, type Db } from './driver';
import { SurrealDb } from './surreal';

const DEFAULT_DATA_DIR = 'data';

export function dataDir(): string {
	return resolve(process.env.WHARFINGER_DATA_DIR ?? DEFAULT_DATA_DIR);
}

/**
 * Picks the storage backend from [storage]. sqlite is the default and
 * keeps the zero-dependency embedded path; surreal talks to a remote
 * SurrealDB over websocket RPC. SurrealDb connects lazily on first
 * statement so this stays synchronous like openDb.
 */
export function openStorage(raw: unknown, dir = dataDir()): Db {
	const cfg = v.parse(StorageSection, raw ?? {});
	if (cfg.driver === 'surreal') {
		if (!cfg.url) throw new Error('[storage].url is required when driver = "surreal"');
		if (cfg.url.startsWith('ws://') || cfg.url.startsWith('http://')) {
			console.warn(
				'[storage] surreal url is plaintext; signin credentials cross the wire unencrypted, use wss://'
			);
		}
		return new SurrealDb({
			url: cfg.url,
			ns: cfg.ns,
			db: cfg.db,
			user: cfg.user,
			pass: cfg.pass,
			timeoutMs: cfg.timeout_ms
		});
	}
	return new SqliteDb(openDb(dir));
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS checks (
	service_id TEXT NOT NULL,
	ts        INTEGER NOT NULL,
	ok        INTEGER NOT NULL,
	latency   INTEGER NOT NULL,
	status    TEXT NOT NULL,
	detail    TEXT
);
CREATE INDEX IF NOT EXISTS idx_checks_service_ts ON checks (service_id, ts);

CREATE TABLE IF NOT EXISTS incidents (
	id          INTEGER PRIMARY KEY AUTOINCREMENT,
	service_id  TEXT NOT NULL,
	severity    TEXT NOT NULL,
	title       TEXT NOT NULL,
	started_at  INTEGER NOT NULL,
	ended_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_incidents_service ON incidents (service_id, started_at);

CREATE TABLE IF NOT EXISTS service_state (
	service_id TEXT PRIMARY KEY,
	status     TEXT NOT NULL,
	latency    INTEGER,
	updated_at INTEGER NOT NULL
);

-- Admin panel: multi-user accounts. role names resolve against the
-- roles table; 'admin', 'operator', and 'viewer' are seeded builtins.
CREATE TABLE IF NOT EXISTS users (
	id            INTEGER PRIMARY KEY AUTOINCREMENT,
	username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
	display_name  TEXT NOT NULL DEFAULT '',
	password_hash TEXT NOT NULL,
	role          TEXT NOT NULL,
	totp_secret   TEXT,
	totp_backup   TEXT,
	created_at    INTEGER NOT NULL,
	disabled_at   INTEGER,
	last_login_at INTEGER
);

-- Panel roles: name -> permission set (JSON array). Builtin rows are
-- seeded by RoleStore and cannot be deleted; admin also ignores its
-- stored permissions so it can never be locked out.
CREATE TABLE IF NOT EXISTS roles (
	name        TEXT PRIMARY KEY,
	label       TEXT NOT NULL,
	permissions TEXT NOT NULL,
	builtin     INTEGER NOT NULL DEFAULT 0,
	created_at  INTEGER NOT NULL
);

-- token_hash is sha256 of the cookie value; raw tokens never hit the db.
CREATE TABLE IF NOT EXISTS sessions (
	token_hash   TEXT PRIMARY KEY,
	user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	created_at   INTEGER NOT NULL,
	expires_at   INTEGER NOT NULL,
	last_seen_at INTEGER NOT NULL,
	ip           TEXT,
	user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

-- Invite and password-reset links. kind is 'invite' or 'reset'.
CREATE TABLE IF NOT EXISTS invites (
	token_hash TEXT PRIMARY KEY,
	kind       TEXT NOT NULL,
	role       TEXT NOT NULL,
	user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
	created_by INTEGER,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	used_at    INTEGER,
	revoked_at INTEGER
);

-- Login attempts for lockout analysis. Pruned aggressively.
CREATE TABLE IF NOT EXISTS login_attempts (
	key      TEXT NOT NULL,
	username TEXT,
	ok       INTEGER NOT NULL,
	at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_key ON login_attempts (key, at);

-- Per-section runtime config overrides. raw_json holds the raw
-- (pre-env-interpolation) section value so env-var secrets are
-- never stored resolved.
CREATE TABLE IF NOT EXISTS config_sections (
	section    TEXT PRIMARY KEY,
	raw_json   TEXT NOT NULL,
	updated_by TEXT,
	updated_at INTEGER NOT NULL
);

-- Audit trail for admin actions and auth events.
CREATE TABLE IF NOT EXISTS audit_log (
	id        INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id   INTEGER,
	username  TEXT,
	action    TEXT NOT NULL,
	detail    TEXT,
	ip        TEXT,
	at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at);

-- Delivery history for outbound notifications.
CREATE TABLE IF NOT EXISTS notification_log (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	target     TEXT NOT NULL,
	kind       TEXT NOT NULL,
	event      TEXT NOT NULL,
	service_id TEXT,
	ok         INTEGER NOT NULL,
	status     INTEGER,
	error      TEXT,
	at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notification_log_at ON notification_log (at);

-- Operator-posted updates attached to monitor-opened incidents.
CREATE TABLE IF NOT EXISTS incident_updates (
	id          INTEGER PRIMARY KEY AUTOINCREMENT,
	incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
	at          INTEGER NOT NULL,
	message     TEXT NOT NULL,
	author      TEXT
);
CREATE INDEX IF NOT EXISTS idx_incident_updates ON incident_updates (incident_id, at);

-- Remote agents reporting through /ingress. token_hash is sha256 of
-- the bearer token; the raw token is shown once at creation and never
-- stored. fingerprint binds the registration to one machine (TOFU).
CREATE TABLE IF NOT EXISTS agents (
	id           TEXT PRIMARY KEY,
	name         TEXT NOT NULL,
	token_hash   TEXT NOT NULL UNIQUE,
	fingerprint  TEXT,
	pubkey       TEXT,
	bind_nonce   TEXT,
	created_at   INTEGER NOT NULL,
	created_by   TEXT,
	last_seen_at INTEGER,
	last_payload TEXT,
	meta         TEXT,
	alerts       TEXT,
	revoked_at   INTEGER
);

-- Downsampled time series for system graphs. Full payloads live in
-- agents.last_payload; these rows power range queries only.
CREATE TABLE IF NOT EXISTS agent_samples (
	agent_id TEXT NOT NULL,
	ts       INTEGER NOT NULL,
	cpu      REAL,
	mem_pct  REAL,
	disk_pct REAL,
	rx_bps   REAL,
	tx_bps   REAL,
	load1    REAL,
	temp_max REAL,
	mem_used REAL,
	disk_used REAL
);
CREATE INDEX IF NOT EXISTS idx_agent_samples ON agent_samples (agent_id, ts);

-- Edge traffic reports pushed by the traefik plugin or any probe
-- sharing an agent token. Numeric columns power charts; report holds
-- the full bounded JSON (top clients, paths, recent errors).
CREATE TABLE IF NOT EXISTS edge_reports (
	agent_id TEXT NOT NULL,
	ts       INTEGER NOT NULL,
	window_s INTEGER NOT NULL,
	requests INTEGER NOT NULL,
	s2xx     INTEGER NOT NULL,
	s3xx     INTEGER NOT NULL,
	s4xx     INTEGER NOT NULL,
	s5xx     INTEGER NOT NULL,
	errs     INTEGER NOT NULL,
	report   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edge_reports ON edge_reports (agent_id, ts);

-- Hub ed25519 keypair for the ws handshake (single row, id pinned).
-- prev_pub/rotated_at/proof record the last rotation: proof is a
-- signature by the previous private key over the new raw pubkey, so
-- pinned agents can adopt the new key. secret is a stable sealed
-- derivation key (push tokens) that survives rotation.
CREATE TABLE IF NOT EXISTS hub_keys (
	id         INTEGER PRIMARY KEY CHECK (id = 1),
	priv       TEXT NOT NULL,
	pub        TEXT NOT NULL,
	prev_pub   TEXT,
	rotated_at INTEGER,
	proof      TEXT,
	secret     TEXT,
	created_at INTEGER NOT NULL
);

-- Local error tracking (Bugsink/GlitchTip-style ingest). Projects own
-- a public DSN key; events group into issues by fingerprint.
CREATE TABLE IF NOT EXISTS telemetry_projects (
	id          INTEGER PRIMARY KEY AUTOINCREMENT,
	name        TEXT NOT NULL,
	public_key  TEXT NOT NULL UNIQUE,
	platform    TEXT,
	created_at  INTEGER NOT NULL,
	disabled_at INTEGER
);

CREATE TABLE IF NOT EXISTS telemetry_issues (
	project_id  INTEGER NOT NULL,
	fingerprint TEXT NOT NULL,
	title       TEXT NOT NULL,
	culprit     TEXT,
	level       TEXT NOT NULL,
	first_seen  INTEGER NOT NULL,
	last_seen   INTEGER NOT NULL,
	count       INTEGER NOT NULL DEFAULT 1,
	resolved_at INTEGER,
	PRIMARY KEY (project_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS telemetry_events (
	id          INTEGER PRIMARY KEY AUTOINCREMENT,
	project_id  INTEGER NOT NULL,
	issue_fp    TEXT NOT NULL,
	event_id    TEXT,
	ts          INTEGER NOT NULL,
	level       TEXT NOT NULL,
	platform    TEXT,
	message     TEXT,
	exc_type    TEXT,
	exc_value   TEXT,
	release     TEXT,
	environment TEXT,
	tags        TEXT,
	request     TEXT,
	stack       TEXT,
	raw         TEXT
);
CREATE INDEX IF NOT EXISTS idx_telemetry_events ON telemetry_events (project_id, issue_fp, ts);

-- Performance envelopes: each transaction item becomes one trace row
-- plus its child spans (the waterfall). Kept out of the issue stream.
CREATE TABLE IF NOT EXISTS telemetry_traces (
	id          INTEGER PRIMARY KEY AUTOINCREMENT,
	project_id  INTEGER NOT NULL,
	trace_id    TEXT NOT NULL,
	span_id     TEXT,
	name        TEXT NOT NULL,
	op          TEXT,
	ts          INTEGER NOT NULL,
	duration_ms INTEGER NOT NULL,
	span_count  INTEGER NOT NULL,
	status      TEXT,
	release     TEXT,
	environment TEXT
);
CREATE INDEX IF NOT EXISTS idx_telemetry_traces_ts ON telemetry_traces (project_id, ts);
CREATE INDEX IF NOT EXISTS idx_telemetry_traces_id ON telemetry_traces (project_id, trace_id);

CREATE TABLE IF NOT EXISTS telemetry_spans (
	id             INTEGER PRIMARY KEY AUTOINCREMENT,
	trace_row_id   INTEGER NOT NULL REFERENCES telemetry_traces(id) ON DELETE CASCADE,
	span_id        TEXT NOT NULL,
	parent_span_id TEXT,
	op             TEXT,
	description    TEXT,
	start_ms       INTEGER NOT NULL,
	end_ms         INTEGER NOT NULL,
	status         TEXT,
	data           TEXT
);
CREATE INDEX IF NOT EXISTS idx_telemetry_spans ON telemetry_spans (trace_row_id);

CREATE TABLE IF NOT EXISTS agent_release_files (
	name        TEXT PRIMARY KEY,
	version     TEXT NOT NULL,
	sha256      TEXT NOT NULL,
	size        INTEGER NOT NULL,
	uploaded_at INTEGER NOT NULL
);

-- Dead-man's-switch beats for push services; one row per service.
CREATE TABLE IF NOT EXISTS push_beats (
	service_id TEXT PRIMARY KEY,
	last_beat  INTEGER NOT NULL,
	beats      INTEGER NOT NULL,
	last_msg   TEXT
);

-- Deployment/release markers shown on charts and the timeline.
CREATE TABLE IF NOT EXISTS markers (
	id      INTEGER PRIMARY KEY,
	ts      INTEGER NOT NULL,
	title   TEXT NOT NULL,
	kind    TEXT NOT NULL,
	source  TEXT,
	service TEXT
);
CREATE INDEX IF NOT EXISTS idx_markers_ts ON markers (ts);

-- Scoped automation keys for the /api/v1 surface; sha256 hash only.
CREATE TABLE IF NOT EXISTS api_keys (
	id         INTEGER PRIMARY KEY,
	name       TEXT NOT NULL,
	key_hash   TEXT NOT NULL UNIQUE,
	scopes     TEXT NOT NULL,
	created_by TEXT,
	created_at INTEGER NOT NULL,
	last_used  INTEGER,
	disabled_at INTEGER
);

-- Public status-page webhook subscriptions; confirm token hashed.
CREATE TABLE IF NOT EXISTS subscribers (
	id           INTEGER PRIMARY KEY,
	url          TEXT NOT NULL UNIQUE,
	services     TEXT NOT NULL,
	secret       TEXT NOT NULL,
	confirm_hash TEXT,
	confirmed_at INTEGER,
	created_at   INTEGER NOT NULL,
	disabled_at  INTEGER
);

-- Passkeys (WebAuthn credentials); a user can hold several.
-- credential_id is the base64url id the authenticator emitted,
-- public_key the raw COSE key, and counter the sign counter used to
-- detect cloned authenticators.
CREATE TABLE IF NOT EXISTS webauthn_credentials (
	id            INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	credential_id TEXT NOT NULL UNIQUE,
	public_key    BLOB NOT NULL,
	counter       INTEGER NOT NULL DEFAULT 0,
	transports    TEXT,
	name          TEXT NOT NULL DEFAULT '',
	backed_up     INTEGER NOT NULL DEFAULT 0,
	created_at    INTEGER NOT NULL,
	last_used_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_webauthn_creds_user ON webauthn_credentials (user_id);

-- Short-lived single-use WebAuthn ceremony challenges, keyed by sha256
-- of the challenge value. user_id is null for discoverable (resident
-- key) login ceremonies where the account is not known up front.
CREATE TABLE IF NOT EXISTS webauthn_challenges (
	token_hash TEXT PRIMARY KEY,
	kind       TEXT NOT NULL,
	user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
	expires_at INTEGER NOT NULL
);

-- Internal staff chat. kind is 'room' or 'dm'; dm_key pins one room
-- per user pair ('<minId>:<maxId>') so find-or-create stays atomic
-- under concurrent opens.
CREATE TABLE IF NOT EXISTS chat_rooms (
	id         TEXT PRIMARY KEY,
	kind       TEXT NOT NULL,
	name       TEXT,
	dm_key     TEXT UNIQUE,
	created_by INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_members (
	room_id      TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
	user_id      INTEGER NOT NULL,
	joined_at    INTEGER NOT NULL,
	last_read_id INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (room_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members (user_id);

-- body is AES-256-GCM sealed with the data key (v1. envelope), so a
-- database dump or backup does not expose message text. This is
-- encryption at rest only, not end-to-end: the server unseals bodies
-- for every member read.
CREATE TABLE IF NOT EXISTS chat_messages (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	room_id    TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
	user_id    INTEGER NOT NULL,
	body       TEXT NOT NULL,
	at         INTEGER NOT NULL,
	edited_at  INTEGER,
	deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_room ON chat_messages (room_id, id);

-- Durable job queue. See .agents/skills/job-queue. job_key dedupes
-- enqueue; lease_owner is a per-claim random token so only the claim
-- holder can heartbeat or finish. 'unknown' marks jobs whose outcome
-- was lost to a restart, pending executor reconciliation.
CREATE TABLE IF NOT EXISTS jobs (
	id           INTEGER PRIMARY KEY AUTOINCREMENT,
	job_key      TEXT NOT NULL UNIQUE,
	kind         TEXT NOT NULL,
	target       TEXT,
	status       TEXT NOT NULL,
	spec         TEXT NOT NULL,
	result       TEXT,
	log          TEXT,
	lease_owner  TEXT,
	lease_until  INTEGER,
	attempts     INTEGER NOT NULL DEFAULT 0,
	max_attempts INTEGER NOT NULL DEFAULT 3,
	created_at   INTEGER NOT NULL,
	updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs (status, kind, target, id);

-- Deployment apps. source/run/route carry the editable spec; a
-- frozen snapshot is baked into each job so mid-flight edits cannot
-- change a running deploy. env is a sealed JSON map; webhook is the
-- per-app hook token shown as /api/deploy/hook/<webhook>.
CREATE TABLE IF NOT EXISTS deploy_apps (
	id          TEXT PRIMARY KEY,
	name        TEXT NOT NULL UNIQUE,
	agent_id    TEXT NOT NULL,
	source      TEXT NOT NULL,
	runtime     TEXT NOT NULL DEFAULT 'podman',
	env         TEXT,
	domains     TEXT NOT NULL DEFAULT '[]',
	healthcheck TEXT NOT NULL DEFAULT '{}',
	ports       TEXT NOT NULL DEFAULT '[]',
	namespace   TEXT,
	replicas    INTEGER,
	webhook_hash TEXT NOT NULL UNIQUE,
	hook_secret TEXT,
	forge_token TEXT,
	created_at  INTEGER NOT NULL,
	updated_at  INTEGER NOT NULL
);

-- Per-app ed25519 deploy keypair for git clones. priv holds the raw
-- 64-byte key (seed||pub) sealed; pub is the OpenSSH wire blob shown
-- for forge registration. Read-only repo access by forge convention.
CREATE TABLE IF NOT EXISTS deploy_keys (
	app_id TEXT PRIMARY KEY REFERENCES deploy_apps(id) ON DELETE CASCADE,
	pub    TEXT NOT NULL,
	priv   TEXT NOT NULL
);

-- Immutable release records. Rollback redeploys a prior release's
-- frozen spec as a new job; status moves pending -> live|failed|
-- rolled_back, and live releases become superseded on the next live.
CREATE TABLE IF NOT EXISTS deploy_releases (
	id         TEXT PRIMARY KEY,
	app_id     TEXT NOT NULL REFERENCES deploy_apps(id) ON DELETE CASCADE,
	job_id     INTEGER,
	spec       TEXT NOT NULL,
	status     TEXT NOT NULL,
	commit_sha TEXT,
	image      TEXT,
	created_at INTEGER NOT NULL,
	live_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_deploy_releases_app ON deploy_releases (app_id, created_at DESC);

-- Named service groups for dashboard filtering and team scoping.
-- Members are polymorphic: 'service' rows key off config service ids,
-- 'app' rows key off deploy_apps.id.
CREATE TABLE IF NOT EXISTS service_groups (
	id         TEXT PRIMARY KEY,
	name       TEXT NOT NULL UNIQUE,
	color      TEXT,
	created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS service_group_members (
	group_id    TEXT NOT NULL REFERENCES service_groups(id) ON DELETE CASCADE,
	member_kind TEXT NOT NULL,
	member_id   TEXT NOT NULL,
	PRIMARY KEY (group_id, member_kind, member_id)
);
CREATE INDEX IF NOT EXISTS idx_sg_members_member ON service_group_members (member_kind, member_id);

-- Teams scope panel users to groups for dashboard visibility.
CREATE TABLE IF NOT EXISTS teams (
	id         TEXT PRIMARY KEY,
	name       TEXT NOT NULL UNIQUE,
	created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
	team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
	user_id INTEGER NOT NULL,
	PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members (user_id);

CREATE TABLE IF NOT EXISTS team_groups (
	team_id  TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
	group_id TEXT NOT NULL REFERENCES service_groups(id) ON DELETE CASCADE,
	PRIMARY KEY (team_id, group_id)
);

-- Named key->value maps sealed whole with the data key (v1. envelope,
-- same as deploy env). Values never appear in list responses.
CREATE TABLE IF NOT EXISTS secret_sets (
	id         TEXT PRIMARY KEY,
	name       TEXT NOT NULL UNIQUE,
	sealed     TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
`;

export function openDb(dir = dataDir()): DatabaseSync {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const dbPath = join(dir, 'wharfinger.db');
	const db = new DatabaseSync(dbPath);
	// The db holds password hashes, sealed TOTP seeds, the hub private
	// key, and token hashes; it deserves the same owner-only mode
	// secrets.key gets instead of whatever the process umask leaves.
	// WAL and SHM siblings inherit the database file's mode.
	try {
		chmodSync(dbPath, 0o600);
		chmodSync(dir, 0o700);
	} catch {
		// best effort on filesystems without posix modes
	}
	db.exec('PRAGMA journal_mode = WAL;');
	db.exec('PRAGMA synchronous = NORMAL;');
	// A second writer (tests, ops tooling, sqlite CLI) must wait for the
	// app's transaction instead of failing with SQLITE_BUSY.
	db.exec('PRAGMA busy_timeout = 5000;');
	db.exec('PRAGMA foreign_keys = ON;');
	db.exec(SCHEMA);
	migrate(db);
	return db;
}

// Column-level changes CREATE TABLE IF NOT EXISTS cannot express.
function migrate(db: DatabaseSync): void {
	const agentCols = (
		db.prepare("SELECT name FROM pragma_table_info('agents')").all() as { name: string }[]
	).map((c) => c.name);
	if (!agentCols.includes('alerts')) {
		// JSON object of active alert keys -> since-ms, e.g. {"offline":1,"cpu":2}
		db.exec('ALTER TABLE agents ADD COLUMN alerts TEXT');
	}
	if (!agentCols.includes('pubkey')) {
		// base64 raw 32-byte ed25519 identity key, TOFU-bound like the
		// fingerprint; null means a pre-proof (legacy) agent.
		db.exec('ALTER TABLE agents ADD COLUMN pubkey TEXT');
	}
	if (!agentCols.includes('bind_nonce')) {
		// Per-connection challenge nonce issued by /ingress/handshake
		// and consumed by /ingress/hello for the key proof.
		db.exec('ALTER TABLE agents ADD COLUMN bind_nonce TEXT');
	}
	const hubCols = (
		db.prepare("SELECT name FROM pragma_table_info('hub_keys')").all() as { name: string }[]
	).map((c) => c.name);
	if (!hubCols.includes('prev_pub')) {
		db.exec('ALTER TABLE hub_keys ADD COLUMN prev_pub TEXT');
		db.exec('ALTER TABLE hub_keys ADD COLUMN rotated_at INTEGER');
		db.exec('ALTER TABLE hub_keys ADD COLUMN proof TEXT');
	}
	if (!hubCols.includes('secret')) {
		// Stable derivation secret for push tokens; backfilled from the
		// current private key so pre-existing push URLs keep working.
		db.exec('ALTER TABLE hub_keys ADD COLUMN secret TEXT');
	}
	// Backfill makes duplicate (agent_id, ts) sample rows possible;
	// collapse any that exist then enforce uniqueness so replays are
	// idempotent (INSERT OR IGNORE at write time).
	db.exec(
		'DELETE FROM agent_samples WHERE rowid NOT IN (SELECT MAX(rowid) FROM agent_samples GROUP BY agent_id, ts)'
	);
	db.exec(
		'CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_samples_uniq ON agent_samples (agent_id, ts)'
	);
	// Same replay discipline for edge reports: plugin retries must not
	// double-count a window.
	db.exec(
		'DELETE FROM edge_reports WHERE rowid NOT IN (SELECT MAX(rowid) FROM edge_reports GROUP BY agent_id, ts)'
	);
	db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_edge_reports_uniq ON edge_reports (agent_id, ts)');
	const cols = (
		db.prepare("SELECT name FROM pragma_table_info('users')").all() as { name: string }[]
	).map((c) => c.name);
	if (!cols.includes('source')) {
		db.exec("ALTER TABLE users ADD COLUMN source TEXT NOT NULL DEFAULT 'local'");
	}
	if (!cols.includes('external_id')) {
		db.exec('ALTER TABLE users ADD COLUMN external_id TEXT');
	}
	if (!cols.includes('avatar')) {
		// Validated image blob + pinned mime; served with nosniff and a
		// null CSP so stored content is inert.
		db.exec('ALTER TABLE users ADD COLUMN avatar BLOB');
		db.exec('ALTER TABLE users ADD COLUMN avatar_mime TEXT');
	}
	db.exec(
		'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_external ON users(source, external_id) WHERE external_id IS NOT NULL'
	);
	const appCols = (
		db.prepare("SELECT name FROM pragma_table_info('deploy_apps')").all() as {
			name: string;
		}[]
	).map((c) => c.name);
	if (!appCols.includes('namespace')) {
		// k8s runtime fields: target namespace (DNS-1123, nullable) and
		// pod replicas (1-10, nullable = runtime default).
		db.exec('ALTER TABLE deploy_apps ADD COLUMN namespace TEXT');
		db.exec('ALTER TABLE deploy_apps ADD COLUMN replicas INTEGER');
	}
	if (!appCols.includes('ports')) {
		// Published port mappings [{host, container}] baked into the
		// spec; also the edge-proxy upstream port for the app.
		db.exec("ALTER TABLE deploy_apps ADD COLUMN ports TEXT NOT NULL DEFAULT '[]'");
	}
	if (!appCols.includes('forge_token')) {
		// Sealed PAT/app token used to post commit statuses back to
		// the forge API.
		db.exec('ALTER TABLE deploy_apps ADD COLUMN forge_token TEXT');
	}
	if (!appCols.includes('preview_of')) {
		// PR preview apps: parent app id, the pull/merge request
		// number, and the teardown deadline the sweep enforces.
		db.exec('ALTER TABLE deploy_apps ADD COLUMN preview_of TEXT');
		db.exec('ALTER TABLE deploy_apps ADD COLUMN preview_pr INTEGER');
		db.exec('ALTER TABLE deploy_apps ADD COLUMN preview_expires INTEGER');
		db.exec(
			'CREATE INDEX IF NOT EXISTS idx_deploy_apps_preview ON deploy_apps (preview_of, preview_pr)'
		);
	}
	// Tamper-evident audit chain: each row hashes its canonical fields
	// plus the previous row's hash. Nullable so pre-chain rows migrate.
	const auditCols = (
		db.prepare("SELECT name FROM pragma_table_info('audit_log')").all() as { name: string }[]
	).map((c) => c.name);
	if (!auditCols.includes('prev_hash')) {
		db.exec('ALTER TABLE audit_log ADD COLUMN prev_hash TEXT');
	}
	if (!auditCols.includes('hash')) {
		db.exec('ALTER TABLE audit_log ADD COLUMN hash TEXT');
	}
	// Backfill rows written before the chain existed, oldest-first in a
	// single bounded pass (the log is capped by AUDIT_LOG_MAX).
	const firstNull = db.prepare('SELECT MIN(id) AS id FROM audit_log WHERE hash IS NULL').get() as {
		id: number | null;
	};
	if (firstNull.id !== null) {
		const prior = db
			.prepare(
				'SELECT hash FROM audit_log WHERE id < ? AND hash IS NOT NULL ORDER BY id DESC LIMIT 1'
			)
			.get(firstNull.id) as { hash: string } | undefined;
		let prev = prior?.hash ?? AUDIT_GENESIS;
		const rows = db
			.prepare(
				'SELECT id, user_id, username, action, detail, ip, at FROM audit_log WHERE hash IS NULL ORDER BY id ASC'
			)
			.all() as unknown as AuditHashRow[];
		const upd = db.prepare('UPDATE audit_log SET prev_hash = ?, hash = ? WHERE id = ?');
		db.exec('BEGIN');
		try {
			for (const row of rows) {
				const hash = auditRowHash(row, prev);
				upd.run(prev, hash, row.id);
				prev = hash;
			}
			db.exec('COMMIT');
		} catch (err) {
			db.exec('ROLLBACK');
			throw err;
		}
	}
}
