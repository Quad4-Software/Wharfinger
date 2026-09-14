import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { building } from '$app/environment';
import { ConfigError, loadRawConfig } from './config/load';
import { resolveEffective, type EffectiveConfig } from './config/effective';
import { ConfigStore } from './config/store';
import type { StatusConfig } from './config/schema';
import { IconCache } from './icons';
import { Monitor } from './monitor/monitor';
import { SseHub } from './sse';
import { SnapshotBuilder } from './status/snapshot';
import { CheckStore } from './store/checks';
import { dataDir, openDb } from './store/db';
import { IncidentStore } from './store/incidents';
import { MarkerStore } from './store/markers';
import { PushStore } from './store/push';
import { ApiKeyStore } from './store/apikeys';
import { SubscriberStore } from './store/subscribers';
import { RateLimiter } from './http/ratelimit';
import { makeEgress, type Egress } from './http/egress';
import {
	ADMIN_API_LIMIT_MAX,
	ADMIN_API_LIMIT_WINDOW_MS,
	AUTH_LIMIT_MAX,
	AUTH_LIMIT_WINDOW_MS,
	RATE_LIMIT_MAX,
	RATE_LIMIT_WINDOW_MS
} from './constants';
import { AgentStore } from './ingress/agents';
import { EdgeStore } from './ingress/edge';
import { UserStore } from './admin/users';
import { adminEnvDisabled, bootstrapAdmin } from './admin/bootstrap';
import { RoleStore } from './admin/roles';
import { SessionStore } from './admin/sessions';
import { InviteStore } from './admin/invites';
import { WebAuthnStore } from './admin/webauthn';
import { LoginProtector } from './admin/protection';
import { AuditStore } from './admin/audit';
import { NotificationLog } from './notify/log';
import { NotifyDispatcher } from './notify/dispatcher';
import { AgentAlerter } from './ingress/alerts';
import { TelemetryStore } from './telemetry/store';
import { AgentReleaseStore } from './agent-release';
import { ChatStore } from './admin/chat';
import { JobQueue } from './jobs/queue';
import { start as startAnomaly } from './anomaly/engine';
import { getScanStore } from './scan/store';
import { DeployStore } from './deploy/store';
import { bindTelemetry } from './telemetry';

export interface Runtime {
	config: StatusConfig;
	db: DatabaseSync;
	monitor: Monitor;
	snapshot: SnapshotBuilder;
	hub: SseHub;
	limiter: RateLimiter;
	authLimiter: RateLimiter;
	adminLimiter: RateLimiter;
	checks: CheckStore;
	incidents: IncidentStore;
	pushBeats: PushStore;
	markers: MarkerStore;
	apiKeys: ApiKeyStore;
	subscribers: SubscriberStore;
	agents: AgentStore;
	edge: EdgeStore;
	icons: IconCache;
	users: UserStore;
	roles: RoleStore;
	sessions: SessionStore;
	invites: InviteStore;
	passkeys: WebAuthnStore;
	protection: LoginProtector;
	audit: AuditStore;
	configStore: ConfigStore;
	notifyLog: NotificationLog;
	dispatcher: NotifyDispatcher;
	alerter: AgentAlerter;
	telemetry: TelemetryStore;
	agentReleases: AgentReleaseStore;
	chat: ChatStore;
	jobs: JobQueue;
	deploys: DeployStore;
	/** Shared outbound connection policy for checks and notifications. */
	egress: Egress;
	/** Raw merged config + override metadata for the admin panel. */
	effective(): EffectiveConfig;
	/** Session cookie lifetime from live config. */
	sessionTtlMs(): number;
	inviteTtlMs(): number;
	adminEnabled(): boolean;
	adminBase(): string;
	/** Re-resolve file + overrides and push through the apply pipeline. */
	reloadConfig(): void;
}

let runtime: Runtime | null = null;

/**
 * Single-process wiring. Called once from hooks.server init and lazily
 * from endpoints so tests and dev reloads get a consistent instance.
 */
export function getRuntime(): Runtime {
	if (runtime) return runtime;
	if (building) throw new Error('runtime not available during build');

	const db = openDb();
	const checks = new CheckStore(db);
	const incidents = new IncidentStore(db);
	const pushBeats = new PushStore(db);
	const markers = new MarkerStore(db);
	const apiKeys = new ApiKeyStore(db);
	const subscribers = new SubscriberStore(db);
	const agents = new AgentStore(db);
	const edge = new EdgeStore(db);
	const users = new UserStore(db);
	const roles = new RoleStore(db, users);
	const sessions = new SessionStore(db, users);
	const invites = new InviteStore(db);
	const passkeys = new WebAuthnStore(db);
	const protection = new LoginProtector(db);
	const audit = new AuditStore(db);
	const configStore = new ConfigStore(db);
	const notifyLog = new NotificationLog(db);
	const telemetry = new TelemetryStore(db);
	const agentReleases = new AgentReleaseStore(db, dataDir());
	const chat = new ChatStore(db, users);
	const jobs = new JobQueue(db);
	const deploys = new DeployStore(db);

	let eff = resolveEffective(loadRawConfig(), configStore);
	let cfg = eff.config;

	// The reporter reads live config through this getter, so reloads
	// and panel overrides apply without a restart.
	bindTelemetry(() => cfg.telemetry);

	// Non-interactive first-admin bootstrap and the env kill switch.
	// WHARFINGER_ADMIN_ENABLED=false wins over config and cannot be undone
	// from inside the panel.
	const envDisabled = adminEnvDisabled();
	switch (bootstrapAdmin(users, audit, process.env, cfg.admin.password_min_length)) {
		case 'created':
			console.log('[admin] created initial admin account from env');
			break;
		case 'incomplete':
			console.warn(
				'[admin] set both WHARFINGER_ADMIN_USERNAME and WHARFINGER_ADMIN_PASSWORD to bootstrap the first admin'
			);
			break;
		case 'invalid':
			console.warn('[admin] env bootstrap skipped: credentials fail username/password policy');
			break;
	}
	if (envDisabled) console.log('[admin] panel disabled via WHARFINGER_ADMIN_ENABLED');

	// One egress policy for monitor checks and notification sends; the
	// allow flag reads live config so reloads apply without a restart.
	const egress = makeEgress(() => cfg.monitor.allow_link_local);
	const monitor = new Monitor(cfg, checks, incidents, egress, pushBeats);
	const icons = new IconCache(join(dataDir(), 'icons'), monitor.userAgent, egress);
	const snapshot = new SnapshotBuilder(() => cfg, monitor, checks, incidents, icons, markers);
	const hub = new SseHub();
	const dispatcher = new NotifyDispatcher(() => cfg, notifyLog, egress, subscribers);
	dispatcher.attach(monitor);
	const alerter = new AgentAlerter(() => cfg, agents, dispatcher);

	// Broadcast fresh snapshots on every monitor event; the builder is
	// cached so this is cheap when nothing changed.
	monitor.on('change', () => {
		hub.broadcast('snapshot', snapshot.current().json);
	});
	monitor.on('update', () => {
		hub.broadcast('snapshot', snapshot.current().json);
	});

	function apply(): void {
		eff = resolveEffective(loadRawConfig(), configStore);
		cfg = eff.config;
		monitor.reload(cfg);
		icons.schedule(cfg.services);
		snapshot.invalidate();
	}

	// Periodic cleanup for admin tables; independent of check retention.
	const cleanup = setInterval(() => {
		try {
			sessions.prune();
			invites.prune();
			passkeys.prune();
			protection.prune();
			audit.prune();
			notifyLog.prune();
			const cutoff = Date.now() - cfg.ingress.sample_retention_days * 86_400_000;
			agents.prune(cutoff);
			edge.prune(cutoff);
			telemetry.prune();
			pushBeats.prune(cfg.services.map((s) => s.id));
			markers.prune(cutoff);
			chat.prune();
			jobs.prune(Date.now() - 30 * 86_400_000);
			getScanStore(db).prune(Date.now() - 90 * 86_400_000);
		} catch (err) {
			console.error('[runtime] cleanup failed:', err);
		}
	}, 3600_000);
	cleanup.unref();

	// Agent silence detection; threshold rules are evaluated on ingest.
	const alertTick = setInterval(() => {
		try {
			alerter.tick();
		} catch (err) {
			console.error('[alerts] tick failed:', err);
		}
	}, 60_000);
	alertTick.unref();

	// Startup + periodic lease recovery: stale claims requeue, stale
	// running jobs go to 'unknown' for reconciliation. See
	// .agents/skills/job-queue.
	const recovered = jobs.recover();
	if (recovered.requeued || recovered.unknown) {
		console.log(`[jobs] recovered: ${recovered.requeued} requeued, ${recovered.unknown} unknown`);
	}
	const jobSweep = setInterval(() => {
		try {
			jobs.recover();
		} catch (err) {
			console.error('[jobs] sweep failed:', err);
		}
	}, 60_000);
	jobSweep.unref();

	runtime = {
		get config() {
			return cfg;
		},
		db,
		monitor,
		snapshot,
		hub,
		limiter: new RateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS),
		authLimiter: new RateLimiter(AUTH_LIMIT_MAX, AUTH_LIMIT_WINDOW_MS),
		adminLimiter: new RateLimiter(ADMIN_API_LIMIT_MAX, ADMIN_API_LIMIT_WINDOW_MS),
		checks,
		incidents,
		pushBeats,
		markers,
		apiKeys,
		subscribers,
		agents,
		edge,
		icons,
		users,
		roles,
		sessions,
		invites,
		passkeys,
		protection,
		audit,
		configStore,
		notifyLog,
		dispatcher,
		alerter,
		telemetry,
		agentReleases,
		chat,
		jobs,
		deploys,
		egress,
		effective: () => eff,
		sessionTtlMs: () => cfg.admin.session_ttl_hours * 3600_000,
		inviteTtlMs: () => cfg.admin.invite_ttl_hours * 3600_000,
		adminEnabled: () => cfg.admin.enabled && !envDisabled,
		adminBase: () => cfg.admin.base_path,
		reloadConfig: apply
	};

	process.on('SIGHUP', () => {
		try {
			runtime?.reloadConfig();
			console.log('[config] reloaded after SIGHUP');
		} catch (err) {
			console.error('[config] reload failed:', err instanceof ConfigError ? err.message : err);
		}
	});

	monitor.start();
	icons.schedule(cfg.services);
	// Anomaly engine: EWMA baselines over auth/deploy/service/agent
	// metrics; alerts fan out through the notify dispatcher.
	startAnomaly(runtime);
	console.log(`[monitor] started, ${cfg.services.length} service(s)`);
	return runtime;
}
