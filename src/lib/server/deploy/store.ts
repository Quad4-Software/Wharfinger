import type { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { asDb, isUniqueViolation, type Db } from '$lib/server/store/driver';
import { sealSecret, openSecret, hashToken, randomToken } from '$lib/server/admin/crypto';
import type {
	AppSource,
	DeployApp,
	DeployRelease,
	DeployRuntime,
	Healthcheck,
	PortMap,
	ReleaseStatus
} from '$lib/shared/deploy';
import { FORGE_KINDS, RUNTIMES, SOURCE_KINDS } from '$lib/shared/deploy';

export class DeployError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}
}

interface AppRow {
	id: string;
	name: string;
	agent_id: string;
	source: string;
	runtime: string;
	env: string | null;
	domains: string;
	healthcheck: string;
	ports: string;
	namespace: string | null;
	replicas: number | null;
	webhook_hash: string;
	hook_secret: string | null;
	forge_token: string | null;
	preview_of: string | null;
	preview_pr: number | null;
	preview_expires: number | null;
	created_at: number;
	updated_at: number;
	has_key?: number;
}

interface ReleaseRow {
	id: string;
	app_id: string;
	job_id: number | null;
	spec: string;
	status: string;
	commit_sha: string | null;
	image: string | null;
	created_at: number;
	live_at: number | null;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DOMAIN_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
const NAMESPACE_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_DOMAINS = 16;
const MAX_ENV_KEYS = 128;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function toApp(r: AppRow): DeployApp {
	return {
		id: r.id,
		name: r.name,
		agentId: r.agent_id,
		source: JSON.parse(r.source) as AppSource,
		runtime: r.runtime as DeployRuntime,
		domains: JSON.parse(r.domains) as string[],
		healthcheck: JSON.parse(r.healthcheck) as Partial<Healthcheck>,
		ports: JSON.parse(r.ports) as PortMap[],
		namespace: r.namespace,
		replicas: r.replicas,
		webhook: '',
		hasEnv: r.env !== null,
		hasHookSecret: r.hook_secret !== null,
		hasDeployKey: r.has_key === 1,
		hasForgeToken: r.forge_token !== null,
		previewOf: r.preview_of ?? null,
		previewPr: r.preview_pr ?? null,
		previewExpires: r.preview_expires ?? null,
		createdAt: r.created_at,
		updatedAt: r.updated_at
	};
}

function toRelease(r: ReleaseRow): DeployRelease {
	return {
		id: r.id,
		appId: r.app_id,
		jobId: r.job_id,
		status: r.status as ReleaseStatus,
		commit: r.commit_sha,
		image: r.image,
		createdAt: r.created_at,
		liveAt: r.live_at
	};
}

function sshStr(buf: Buffer | string): Buffer {
	const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
	const len = Buffer.alloc(4);
	len.writeUInt32BE(b.length);
	return Buffer.concat([len, b]);
}

/** OpenSSH public key line for a raw 32-byte ed25519 key. */
export function opensshPub(pubRaw: Buffer, comment = 'wharfinger-deploy'): string {
	const blob = Buffer.concat([sshStr('ssh-ed25519'), sshStr(pubRaw)]);
	return `ssh-ed25519 ${blob.toString('base64')} ${comment}`;
}

function appQuery(hasKey = true): string {
	return `SELECT a.*, ${hasKey ? '(SELECT 1 FROM deploy_keys k WHERE k.app_id = a.id)' : 'NULL'} AS has_key FROM deploy_apps a`;
}

export class DeployStore {
	private readonly db: Db;

	constructor(db: Db | DatabaseSync) {
		this.db = asDb(db);
	}

	async createApp(opts: {
		name: string;
		agentId: string;
		source: AppSource;
		runtime?: DeployRuntime;
		domains?: string[];
		healthcheck?: Healthcheck;
		ports?: PortMap[];
		namespace?: string | null;
		replicas?: number | null;
	}): Promise<{ app: DeployApp; webhook: string; deployKeyPub: string }> {
		const name = opts.name.trim().toLowerCase();
		if (!NAME_RE.test(name)) throw new DeployError(422, 'name must be lowercase dns-label style');
		const source = this.validateSource(opts.source);
		const runtime = opts.runtime ?? 'podman';
		if (!RUNTIMES.includes(runtime))
			throw new DeployError(422, `runtime must be ${RUNTIMES.join(', ')}`);
		const domains = this.validateDomains(opts.domains ?? []);
		const healthcheck = this.validateHealthcheck(opts.healthcheck);
		const ports = this.validatePorts(opts.ports ?? []);
		const kube = this.validateKube(runtime, opts.namespace, opts.replicas);

		const id = `app_${randomBytes(9).toString('base64url')}`;
		const webhook = randomToken();
		const now = Date.now();
		const kp = generateKeyPairSync('ed25519');
		const pubJwk = kp.publicKey.export({ format: 'jwk' }) as { x: string };
		const privJwk = kp.privateKey.export({ format: 'jwk' }) as { d: string };
		const pubRaw = Buffer.from(pubJwk.x, 'base64url');
		const privRaw = Buffer.concat([Buffer.from(privJwk.d, 'base64url'), pubRaw]);

		try {
			await this.db.tx(async (tx) => {
				await tx
					.prepare(
						`INSERT INTO deploy_apps (id, name, agent_id, source, runtime, domains, healthcheck, ports, namespace, replicas, webhook_hash, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
					)
					.run(
						id,
						name,
						opts.agentId,
						JSON.stringify(source),
						runtime,
						JSON.stringify(domains),
						JSON.stringify(healthcheck),
						JSON.stringify(ports),
						kube.namespace,
						kube.replicas,
						hashToken(webhook),
						now,
						now
					);
				await tx
					.prepare('INSERT INTO deploy_keys (app_id, pub, priv) VALUES (?, ?, ?)')
					.run(id, pubRaw.toString('base64'), sealSecret(privRaw.toString('base64')));
			});
		} catch (err) {
			if (isUniqueViolation(err)) throw new DeployError(409, 'an app with that name exists');
			throw err;
		}
		const app = await this.getApp(id);
		if (!app) throw new DeployError(500, 'app missing after create');
		return { app, webhook, deployKeyPub: opensshPub(pubRaw, `wharfinger-${name}`) };
	}

	private validateSource(source: AppSource): AppSource {
		const kind = String((source as { kind?: unknown } | null)?.kind);
		if (!(SOURCE_KINDS as readonly string[]).includes(kind)) {
			throw new DeployError(422, `source kind must be one of ${SOURCE_KINDS.join(', ')}`);
		}
		const out: AppSource = { kind: source.kind };
		if (source.kind === 'git') {
			if (typeof source.url !== 'string' || source.url.length > 500) {
				throw new DeployError(422, 'git source needs a url');
			}
			// ssh and https clone urls only; local paths and file:// are
			// refused so an app cannot read the hub filesystem.
			if (!/^(https:\/\/|ssh:\/\/|git@)/.test(source.url)) {
				throw new DeployError(422, 'git url must be https, ssh://, or git@');
			}
			out.url = source.url;
			out.ref = typeof source.ref === 'string' ? source.ref.slice(0, 200) : 'main';
			if (source.subdir) out.subdir = source.subdir.slice(0, 200);
			if (source.forge !== undefined) {
				if (!(FORGE_KINDS as readonly string[]).includes(source.forge)) {
					throw new DeployError(422, `forge must be one of ${FORGE_KINDS.join(', ')}`);
				}
				out.forge = source.forge;
			}
			if (source.paths !== undefined) {
				if (!Array.isArray(source.paths) || source.paths.length > 64) {
					throw new DeployError(422, 'paths must be an array of up to 64 globs');
				}
				out.paths = source.paths.map((p: unknown) => {
					const s = String(p).trim().replace(/^\/+/, '');
					if (!s || s.length > 200 || s.includes('..')) {
						throw new DeployError(422, `invalid path filter: ${s || String(p).slice(0, 60)}`);
					}
					return s;
				});
			}
			if (source.submodules === true) out.submodules = true;
			if (source.lfs === true) out.lfs = true;
			if (source.previews === true) out.previews = true;
		} else if (source.kind === 'image') {
			if (typeof source.url !== 'string' || !/^[a-z0-9./:_@-]+$/i.test(source.url)) {
				throw new DeployError(422, 'image source needs a registry reference');
			}
			out.url = source.url.slice(0, 300);
		} else {
			out.url = typeof source.url === 'string' ? source.url.slice(0, 500) : undefined;
			if (source.subdir) out.subdir = source.subdir.slice(0, 200);
		}
		return out;
	}

	private validateDomains(domains: string[]): string[] {
		const clean = domains
			.map((d) =>
				String(d as unknown)
					.trim()
					.toLowerCase()
			)
			.filter(Boolean)
			.slice(0, MAX_DOMAINS);
		for (const d of clean) {
			if (d.length > 253 || !DOMAIN_RE.test(d)) throw new DeployError(422, `invalid domain: ${d}`);
		}
		return [...new Set(clean)];
	}

	private validateHealthcheck(hc?: Healthcheck): Partial<Healthcheck> {
		if (!hc) return {};
		if (!Number.isInteger(hc.port) || hc.port < 1 || hc.port > 65535) {
			throw new DeployError(422, 'healthcheck port must be 1-65535');
		}
		const kind = String((hc as { kind: unknown }).kind);
		if (!['http', 'tcp'].includes(kind)) {
			throw new DeployError(422, 'healthcheck kind must be http or tcp');
		}
		return {
			kind: hc.kind,
			port: hc.port,
			path: hc.path?.slice(0, 200),
			intervalMs: Math.min(Math.max(Number(hc.intervalMs) || 5000, 500), 60_000),
			timeoutMs: Math.min(Math.max(Number(hc.timeoutMs) || 3000, 250), 60_000),
			retries: Math.min(Math.max(Number(hc.retries) || 12, 1), 300)
		};
	}

	// Published ports: host-side port on the agent mapped to the
	// container port. Host ports must be unique within the app; the
	// first mapping is what the edge route table dials.
	private validatePorts(ports: PortMap[]): PortMap[] {
		if (!Array.isArray(ports)) throw new DeployError(422, 'ports must be an array');
		if (ports.length > 16) throw new DeployError(422, 'too many port mappings (max 16)');
		const hosts = new Set<number>();
		return (ports as unknown[]).map((p) => {
			const raw = (p ?? {}) as { host?: unknown; container?: unknown; local?: unknown };
			const host = Number(raw.host);
			const container = Number(raw.container);
			if (
				!Number.isInteger(host) ||
				host < 1 ||
				host > 65535 ||
				!Number.isInteger(container) ||
				container < 1 ||
				container > 65535
			) {
				throw new DeployError(422, 'ports must be integer host/container pairs 1-65535');
			}
			if (hosts.has(host)) throw new DeployError(422, `duplicate host port ${host}`);
			hosts.add(host);
			const out: PortMap = { host, container };
			if (raw.local === true) out.local = true;
			return out;
		});
	}

	// k8s-only fields: rejected outright on container runtimes so a
	// namespace can never ride along on a podman app.
	private validateKube(
		runtime: DeployRuntime,
		namespace?: string | null,
		replicas?: number | null
	): { namespace: string | null; replicas: number | null } {
		if (runtime !== 'k8s') {
			if (namespace || replicas != null) {
				throw new DeployError(422, 'namespace and replicas require the k8s runtime');
			}
			return { namespace: null, replicas: null };
		}
		const raw = namespace?.trim() ?? '';
		if (raw !== '' && !NAMESPACE_RE.test(raw)) {
			throw new DeployError(422, 'namespace must be a DNS-1123 label');
		}
		const ns = raw === '' ? null : raw;
		const rep = replicas ?? null;
		if (rep !== null) {
			if (!Number.isInteger(rep) || rep < 1 || rep > 10) {
				throw new DeployError(422, 'replicas must be an integer 1-10');
			}
		}
		return { namespace: ns, replicas: rep };
	}

	async getApp(id: string): Promise<DeployApp | null> {
		const row = (await this.db.prepare(`${appQuery()} WHERE a.id = ?`).get(id)) as
			AppRow | undefined;
		return row ? toApp(row) : null;
	}

	async byName(name: string): Promise<DeployApp | null> {
		const row = (await this.db.prepare(`${appQuery()} WHERE a.name = ?`).get(name)) as
			AppRow | undefined;
		return row ? toApp(row) : null;
	}

	async byWebhook(token: string): Promise<DeployApp | null> {
		const row = (await this.db
			.prepare(`${appQuery()} WHERE a.webhook_hash = ?`)
			.get(hashToken(token))) as AppRow | undefined;
		return row ? toApp(row) : null;
	}

	async listApps(agentId?: string): Promise<DeployApp[]> {
		const rows = agentId
			? ((await this.db
					.prepare(`${appQuery()} WHERE a.agent_id = ? ORDER BY a.name`)
					.all(agentId)) as unknown as AppRow[])
			: ((await this.db.prepare(`${appQuery()} ORDER BY a.name`).all()) as unknown as AppRow[]);
		return rows.map(toApp);
	}

	async updateApp(
		id: string,
		patch: Partial<{
			name: string;
			agentId: string;
			source: AppSource;
			runtime: DeployRuntime;
			domains: string[];
			healthcheck: Healthcheck;
			ports: PortMap[];
			namespace: string | null;
			replicas: number | null;
			expectedUpdatedAt: number;
		}>
	): Promise<DeployApp> {
		const app = await this.getApp(id);
		if (!app) throw new DeployError(404, 'app not found');
		const sets: string[] = [];
		const args: (string | number | null)[] = [];
		if (patch.name !== undefined) {
			const name = patch.name.trim().toLowerCase();
			if (!NAME_RE.test(name)) throw new DeployError(422, 'name must be lowercase dns-label style');
			sets.push('name = ?');
			args.push(name);
		}
		if (patch.agentId !== undefined) {
			sets.push('agent_id = ?');
			args.push(patch.agentId);
		}
		if (patch.source !== undefined) {
			sets.push('source = ?');
			args.push(JSON.stringify(this.validateSource(patch.source)));
		}
		if (patch.runtime !== undefined) {
			if (!RUNTIMES.includes(patch.runtime)) throw new DeployError(422, 'invalid runtime');
			sets.push('runtime = ?');
			args.push(patch.runtime);
			// Switching away from k8s clears the k8s-only fields so a
			// stale namespace never follows the app.
			if (patch.runtime !== 'k8s' && patch.namespace === undefined) {
				sets.push('namespace = NULL', 'replicas = NULL');
			}
		}
		if (patch.namespace !== undefined || patch.replicas !== undefined) {
			const runtime = patch.runtime ?? app.runtime;
			const kube = this.validateKube(
				runtime,
				patch.namespace !== undefined ? patch.namespace : app.namespace,
				patch.replicas !== undefined ? patch.replicas : app.replicas
			);
			sets.push('namespace = ?', 'replicas = ?');
			args.push(kube.namespace, kube.replicas);
		}
		if (patch.domains !== undefined) {
			sets.push('domains = ?');
			args.push(JSON.stringify(this.validateDomains(patch.domains)));
		}
		if (patch.healthcheck !== undefined) {
			sets.push('healthcheck = ?');
			args.push(JSON.stringify(this.validateHealthcheck(patch.healthcheck)));
		}
		if (patch.ports !== undefined) {
			sets.push('ports = ?');
			args.push(JSON.stringify(this.validatePorts(patch.ports)));
		}
		if (!sets.length) return app;
		// MAX() keeps the stamp strictly increasing: two writes in the
		// same millisecond must still produce distinct stamps or the
		// optimistic-concurrency guard below cannot tell them apart.
		sets.push('updated_at = MAX(?, updated_at + 1)');
		args.push(Date.now(), id);
		// Optimistic concurrency: the writer must have seen the row it
		// is replacing. A stale stamp means someone else edited first.
		let guard = '';
		if (patch.expectedUpdatedAt !== undefined) {
			guard = ' AND updated_at = ?';
			args.push(patch.expectedUpdatedAt);
		}
		try {
			const n = await this.db
				.prepare(`UPDATE deploy_apps SET ${sets.join(', ')} WHERE id = ?${guard}`)
				.run(...args);
			if (!Number(n.changes))
				throw new DeployError(409, 'app changed since it was loaded; reload and retry');
		} catch (err) {
			if (err instanceof DeployError) throw err;
			if (isUniqueViolation(err)) throw new DeployError(409, 'an app with that name exists');
			throw err;
		}
		const updated = await this.getApp(id);
		if (!updated) throw new DeployError(500, 'app missing after update');
		return updated;
	}

	async deleteApp(id: string): Promise<boolean> {
		return this.db.tx(async (tx) => {
			await tx.prepare('DELETE FROM deploy_keys WHERE app_id = ?').run(id);
			await tx.prepare('DELETE FROM deploy_releases WHERE app_id = ?').run(id);
			const res = await tx.prepare('DELETE FROM deploy_apps WHERE id = ?').run(id);
			return Number(res.changes) === 1;
		});
	}

	/**
	 * Create a PR preview app under a parent. Sealed columns (env,
	 * hook secret, forge token) and the deploy key row are copied
	 * verbatim: same hub key, same repo access, and nothing is ever
	 * decrypted or logged on this path.
	 */
	async createPreviewApp(
		parent: DeployApp,
		opts: {
			name: string;
			pr: number;
			source: AppSource;
			domains: string[];
			ports: PortMap[];
			expiresAt: number;
		}
	): Promise<DeployApp> {
		const source = this.validateSource(opts.source);
		const domains = this.validateDomains(opts.domains);
		const ports = this.validatePorts(opts.ports);
		const id = `app_${randomBytes(9).toString('base64url')}`;
		const webhook = randomToken();
		const now = Date.now();
		// A preview for the same parent+PR can be created by two
		// racing deliveries; inside the serialized tx the second one
		// sees the first row and returns it instead of duplicating.
		let appId = id;
		try {
			await this.db.tx(async (tx) => {
				const dup = (await tx
					.prepare('SELECT id FROM deploy_apps WHERE preview_of = ? AND preview_pr = ?')
					.get(parent.id, opts.pr)) as { id: string } | undefined;
				if (dup) {
					appId = dup.id;
					return;
				}
				const secrets = (await tx
					.prepare('SELECT env, hook_secret, forge_token FROM deploy_apps WHERE id = ?')
					.get(parent.id)) as
					| { env: string | null; hook_secret: string | null; forge_token: string | null }
					| undefined;
				if (!secrets) throw new DeployError(404, 'parent app not found');
				await tx
					.prepare(
						`INSERT INTO deploy_apps (id, name, agent_id, source, runtime, env, domains, healthcheck, ports, namespace, replicas, webhook_hash, hook_secret, forge_token, preview_of, preview_pr, preview_expires, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
					)
					.run(
						id,
						opts.name,
						parent.agentId,
						JSON.stringify(source),
						parent.runtime,
						secrets.env,
						JSON.stringify(domains),
						JSON.stringify(parent.healthcheck),
						JSON.stringify(ports),
						parent.namespace,
						parent.replicas,
						hashToken(webhook),
						secrets.hook_secret,
						secrets.forge_token,
						parent.id,
						opts.pr,
						opts.expiresAt,
						now,
						now
					);
				const key = (await tx
					.prepare('SELECT pub, priv FROM deploy_keys WHERE app_id = ?')
					.get(parent.id)) as { pub: string; priv: string } | undefined;
				if (key) {
					await tx
						.prepare('INSERT INTO deploy_keys (app_id, pub, priv) VALUES (?, ?, ?)')
						.run(id, key.pub, key.priv);
				}
			});
		} catch (err) {
			if (err instanceof DeployError) throw err;
			if (isUniqueViolation(err)) {
				throw new DeployError(409, 'an app with that name exists');
			}
			throw err;
		}
		const app = await this.getApp(appId);
		if (!app) throw new DeployError(500, 'preview app missing after create');
		return app;
	}

	/** The preview app for one pull/merge request on a parent. */
	async previewFor(parentId: string, pr: number): Promise<DeployApp | null> {
		const row = (await this.db
			.prepare(`${appQuery()} WHERE a.preview_of = ? AND a.preview_pr = ?`)
			.get(parentId, pr)) as AppRow | undefined;
		return row ? toApp(row) : null;
	}

	/** All previews under a parent, oldest first. */
	async previewsFor(parentId: string): Promise<DeployApp[]> {
		const rows = (await this.db
			.prepare(`${appQuery()} WHERE a.preview_of = ? ORDER BY a.created_at`)
			.all(parentId)) as unknown as AppRow[];
		return rows.map(toApp);
	}

	/** Previews past their teardown deadline. */
	async expiredPreviews(now: number): Promise<DeployApp[]> {
		const rows = (await this.db
			.prepare(`${appQuery()} WHERE a.preview_expires IS NOT NULL AND a.preview_expires < ?`)
			.all(now)) as unknown as AppRow[];
		return rows.map(toApp);
	}

	/** Extend a preview's teardown deadline on each new push. */
	async touchPreview(id: string, expiresAt: number): Promise<void> {
		await this.db
			.prepare('UPDATE deploy_apps SET preview_expires = ?, updated_at = ? WHERE id = ?')
			.run(expiresAt, Date.now(), id);
	}

	/** Host ports already claimed by apps on one agent, for preview allocation. */
	async usedHostPorts(agentId: string): Promise<Set<number>> {
		const rows = (await this.db
			.prepare('SELECT ports FROM deploy_apps WHERE agent_id = ?')
			.all(agentId)) as { ports: string }[];
		const used = new Set<number>();
		for (const r of rows) {
			try {
				for (const p of JSON.parse(r.ports) as PortMap[]) {
					if (Number.isInteger(p.host)) used.add(p.host);
				}
			} catch {
				// A corrupt ports blob cannot block allocation.
			}
		}
		return used;
	}

	/** Sealed env map; fetched by the bound agent through the secrets endpoint. */
	async setEnv(id: string, env: Record<string, string>, expectedUpdatedAt?: number): Promise<void> {
		if (!(await this.getApp(id))) throw new DeployError(404, 'app not found');
		const keys = Object.keys(env);
		if (keys.length > MAX_ENV_KEYS) throw new DeployError(422, 'too many env keys');
		for (const k of keys) {
			if (!ENV_KEY_RE.test(k)) throw new DeployError(422, `invalid env key: ${k}`);
			if (env[k].length > 32 * 1024) throw new DeployError(422, 'env value too large');
		}
		let sql = 'UPDATE deploy_apps SET env = ?, updated_at = MAX(?, updated_at + 1) WHERE id = ?';
		const args: (string | number)[] = [sealSecret(JSON.stringify(env)), Date.now(), id];
		if (expectedUpdatedAt !== undefined) {
			sql += ' AND updated_at = ?';
			args.push(expectedUpdatedAt);
		}
		const res = await this.db.prepare(sql).run(...args);
		if (!Number(res.changes)) {
			throw new DeployError(409, 'app changed since it was loaded; reload and retry');
		}
	}

	async envFor(id: string): Promise<Record<string, string>> {
		const row = (await this.db.prepare('SELECT env FROM deploy_apps WHERE id = ?').get(id)) as
			{ env: string | null } | undefined;
		if (!row?.env) return {};
		const plain = openSecret(row.env);
		if (plain === null) throw new DeployError(500, 'sealed env is unreadable');
		return JSON.parse(plain) as Record<string, string>;
	}

	async setHookSecret(id: string, secret: string): Promise<void> {
		await this.db
			.prepare('UPDATE deploy_apps SET hook_secret = ?, updated_at = ? WHERE id = ?')
			.run(sealSecret(secret), Date.now(), id);
	}

	async hookSecret(id: string): Promise<string | null> {
		const row = (await this.db
			.prepare('SELECT hook_secret FROM deploy_apps WHERE id = ?')
			.get(id)) as { hook_secret: string | null } | undefined;
		return row?.hook_secret ? (openSecret(row.hook_secret) ?? null) : null;
	}

	/**
	 * Forge API token (PAT/app token) for commit status posts. An
	 * empty string clears it. Sealed like every other secret column.
	 */
	async setForgeToken(id: string, token: string): Promise<void> {
		await this.db
			.prepare('UPDATE deploy_apps SET forge_token = ?, updated_at = ? WHERE id = ?')
			.run(token === '' ? null : sealSecret(token), Date.now(), id);
	}

	async forgeToken(id: string): Promise<string | null> {
		const row = (await this.db
			.prepare('SELECT forge_token FROM deploy_apps WHERE id = ?')
			.get(id)) as { forge_token: string | null } | undefined;
		if (!row?.forge_token) return null;
		const plain = openSecret(row.forge_token);
		if (plain === null) throw new DeployError(500, 'sealed forge token is unreadable');
		return plain;
	}

	async rotateWebhook(id: string): Promise<string> {
		const webhook = randomToken();
		const res = await this.db
			.prepare('UPDATE deploy_apps SET webhook_hash = ?, updated_at = ? WHERE id = ?')
			.run(hashToken(webhook), Date.now(), id);
		if (!Number(res.changes)) throw new DeployError(404, 'app not found');
		return webhook;
	}

	/** Raw 64-byte ed25519 deploy key, released only to the lease-holding agent. */
	async deployKeyFor(id: string): Promise<{ priv: Buffer; pub: string } | null> {
		const row = (await this.db
			.prepare('SELECT pub, priv FROM deploy_keys WHERE app_id = ?')
			.get(id)) as { pub: string; priv: string } | undefined;
		if (!row) return null;
		const priv = openSecret(row.priv);
		if (priv === null) throw new DeployError(500, 'sealed deploy key is unreadable');
		return { priv: Buffer.from(priv, 'base64'), pub: row.pub };
	}

	async rotateDeployKey(id: string): Promise<string> {
		if (!(await this.getApp(id))) throw new DeployError(404, 'app not found');
		const kp = generateKeyPairSync('ed25519');
		const pubJwk = kp.publicKey.export({ format: 'jwk' }) as { x: string };
		const privJwk = kp.privateKey.export({ format: 'jwk' }) as { d: string };
		const pubRaw = Buffer.from(pubJwk.x, 'base64url');
		const privRaw = Buffer.concat([Buffer.from(privJwk.d, 'base64url'), pubRaw]);
		await this.db
			.prepare('UPDATE deploy_keys SET pub = ?, priv = ? WHERE app_id = ?')
			.run(pubRaw.toString('base64'), sealSecret(privRaw.toString('base64')), id);
		return opensshPub(pubRaw);
	}

	async createRelease(
		appId: string,
		spec: string,
		jobId: number | null,
		id?: string
	): Promise<DeployRelease> {
		id ??= `rel_${randomBytes(9).toString('base64url')}`;
		await this.db
			.prepare(
				`INSERT INTO deploy_releases (id, app_id, job_id, spec, status, created_at)
				 VALUES (?, ?, ?, ?, 'pending', ?)`
			)
			.run(id, appId, jobId, spec, Date.now());
		const release = await this.release(id);
		if (!release) throw new DeployError(500, 'release missing after create');
		return release;
	}

	async release(id: string): Promise<DeployRelease | null> {
		const row = (await this.db.prepare('SELECT * FROM deploy_releases WHERE id = ?').get(id)) as
			ReleaseRow | undefined;
		return row ? toRelease(row) : null;
	}

	async releaseSpec(id: string): Promise<string | null> {
		const row = (await this.db.prepare('SELECT spec FROM deploy_releases WHERE id = ?').get(id)) as
			{ spec: string } | undefined;
		return row?.spec ?? null;
	}

	async releases(appId: string, limit = 50): Promise<DeployRelease[]> {
		return (
			(await this.db
				.prepare('SELECT * FROM deploy_releases WHERE app_id = ? ORDER BY created_at DESC LIMIT ?')
				.all(appId, limit)) as unknown as ReleaseRow[]
		).map(toRelease);
	}

	async liveRelease(appId: string): Promise<DeployRelease | null> {
		const row = (await this.db
			.prepare(
				"SELECT * FROM deploy_releases WHERE app_id = ? AND status = 'live' ORDER BY live_at DESC LIMIT 1"
			)
			.get(appId)) as ReleaseRow | undefined;
		return row ? toRelease(row) : null;
	}

	/** Mark a release live and supersede the previous live one atomically. */
	async markLive(id: string, meta: { commit?: string; image?: string } = {}): Promise<void> {
		await this.db.tx(async (tx) => {
			const row = (await tx.prepare('SELECT app_id FROM deploy_releases WHERE id = ?').get(id)) as
				{ app_id: string } | undefined;
			if (!row) return;
			await tx
				.prepare(
					"UPDATE deploy_releases SET status = 'superseded' WHERE app_id = ? AND status = 'live'"
				)
				.run(row.app_id);
			await tx
				.prepare(
					"UPDATE deploy_releases SET status = 'live', live_at = ?, commit_sha = COALESCE(?, commit_sha), image = COALESCE(?, image) WHERE id = ?"
				)
				.run(Date.now(), meta.commit ?? null, meta.image ?? null, id);
		});
	}

	/** Record the pushed commit sha on a pending release (webhook path). */
	async noteCommit(id: string, commitSha: string): Promise<void> {
		await this.db
			.prepare("UPDATE deploy_releases SET commit_sha = ? WHERE id = ? AND status = 'pending'")
			.run(commitSha.slice(0, 64), id);
	}

	async markRelease(
		id: string,
		status: 'failed' | 'rolled_back',
		meta: { commit?: string; image?: string } = {}
	): Promise<void> {
		await this.db
			.prepare(
				'UPDATE deploy_releases SET status = ?, commit_sha = COALESCE(?, commit_sha), image = COALESCE(?, image) WHERE id = ?'
			)
			.run(status, meta.commit ?? null, meta.image ?? null, id);
	}

	async linkJob(id: string, jobId: number): Promise<void> {
		await this.db.prepare('UPDATE deploy_releases SET job_id = ? WHERE id = ?').run(jobId, id);
	}
}
