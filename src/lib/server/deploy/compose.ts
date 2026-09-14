// Docker compose -> deploy app converter. Each service becomes a
// linked app draft; keys that cannot be expressed in the app model
// are reported loudly instead of silently dropped.
import { isMap, isSeq, parseDocument } from 'yaml';
import type { AppSource, Healthcheck, PortMap } from '$lib/shared/deploy';

interface ComposeDraft {
	name: string;
	source: AppSource;
	env: Record<string, string>;
	ports: PortMap[];
	healthcheck: Partial<Healthcheck>;
	// Keys that exist but cannot be expressed: surfaced verbatim so
	// the operator sees exactly what was not translated.
	unsupported: string[];
	// Non-fatal caveats (dropped ordering, restart policy, etc).
	notes: string[];
	// Set when the service cannot convert at all.
	error?: string;
}

export interface ComposePlan {
	project: string;
	services: ComposeDraft[];
	warnings: string[];
}

// Keys with no app-model equivalent. Anything in this list that
// appears on a service lands in unsupported[] with no translation.
const UNSUPPORTED_KEYS = new Set([
	'volumes',
	'networks',
	'command',
	'entrypoint',
	'env_file',
	'extends',
	'profiles',
	'deploy',
	'logging',
	'cap_add',
	'cap_drop',
	'devices',
	'tmpfs',
	'secrets',
	'configs',
	'init',
	'tty',
	'stdin_open',
	'working_dir',
	'user',
	'hostname',
	'dns',
	'dns_search',
	'extra_hosts',
	'links',
	'external_links',
	'pid',
	'ipc',
	'shm_size',
	'sysctls',
	'ulimits',
	'platform',
	'pull_policy',
	'read_only',
	'security_opt',
	'stop_grace_period',
	'stop_signal',
	'userns_mode',
	'cgroup_parent',
	'isolation',
	'storage_opt',
	'oom_kill_disable',
	'oom_score_adj',
	'privileged'
]);

const GIT_CTX_RE = /^(https:\/\/|ssh:\/\/|git@)\S+$/;

// Fold a compose service name into the dns-label shape app names use.
function foldName(name: string): string {
	const folded = name
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 63)
		.replace(/^-+|-+$/g, '');
	return /^[a-z0-9]/.test(folded) ? folded : `svc-${folded || 'x'}`;
}

// Compose duration "1m30s" / "500ms" / "10s" -> milliseconds.
function durationMs(v: string): number | null {
	const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(v.trim());
	if (!m) return null;
	const n = Number(m[1]);
	switch (m[2] || 's') {
		case 'ms':
			return Math.round(n);
		case 's':
			return Math.round(n * 1000);
		case 'm':
			return Math.round(n * 60_000);
		case 'h':
			return Math.round(n * 3_600_000);
	}
	return null;
}

// Unwrap a yaml node to its primitive value. Maps and sequences
// keep their node shape so callers can still type-test them.
function scalar(node: unknown): unknown {
	if (node === null || node === undefined) return node;
	if (typeof node === 'object' && 'value' in (node as { value?: unknown })) {
		return (node as { value: unknown }).value;
	}
	return node;
}

// String form of a scalar yaml node; non-primitives become '' so
// nested maps never stringify to [object Object] into user-facing
// notes or app fields.
function str(node: unknown): string {
	const v = scalar(node);
	if (typeof v === 'string') return v;
	if (typeof v === 'number' || typeof v === 'boolean') return String(v);
	return '';
}

function portMapping(entry: unknown, draft: ComposeDraft): void {
	// Long syntax: {target, published, host_ip, protocol, mode}.
	if (isMap(entry)) {
		const target = Number(scalar(entry.get('target')));
		const published = Number(scalar(entry.get('published')));
		if (!Number.isInteger(target) || !Number.isInteger(published)) {
			draft.notes.push('port mapping needs target+published numbers');
			return;
		}
		const proto = str(entry.get('protocol')) || 'tcp';
		if (proto !== 'tcp') {
			draft.notes.push(`port ${published}:${target}/${proto}: only tcp is proxied`);
		}
		const hostIp = str(entry.get('host_ip'));
		const pm: PortMap = { host: published, container: target };
		if (hostIp === '127.0.0.1' || hostIp === 'localhost' || hostIp === '::1') pm.local = true;
		else if (hostIp) draft.notes.push(`host_ip ${hostIp} on ${published}:${target} ignored`);
		if (str(entry.get('mode')) === 'ingress') {
			draft.notes.push(`port ${published}:${target}: swarm ingress mode ignored`);
		}
		draft.ports.push(pm);
		return;
	}
	const raw = str(entry).trim();
	if (!raw) return;
	let proto = 'tcp';
	let spec = raw;
	const slash = raw.indexOf('/');
	if (slash >= 0) {
		proto = raw.slice(slash + 1);
		spec = raw.slice(0, slash);
	}
	if (proto !== 'tcp') draft.notes.push(`port ${raw}: only tcp is proxied`);
	const parts = spec.split(':');
	let host: string;
	let container: string;
	let local = false;
	if (parts.length === 3) {
		const ip = parts[0];
		if (ip === '127.0.0.1' || ip === 'localhost' || ip === '::1') local = true;
		else if (ip) draft.notes.push(`bind ip ${ip} on ${raw} ignored`);
		host = parts[1];
		container = parts[2];
	} else if (parts.length === 2) {
		[host, container] = parts;
	} else {
		// "80" publishes the container port on a random host port;
		// pin it to the same number so the mapping is explicit.
		container = parts[0];
		host = parts[0];
		draft.notes.push(`port ${raw}: random host publish pinned to ${host}`);
	}
	// Ranges like 8080-8082:80 take their first port.
	for (const side of [host, container]) {
		const dash = side.indexOf('-');
		if (dash >= 0) {
			draft.notes.push(`port range ${raw}: only ${side.slice(0, dash)} mapped`);
		}
	}
	const h = Number(host.split('-')[0]);
	const c = Number(container.split('-')[0]);
	if (!Number.isInteger(h) || h < 1 || h > 65535 || !Number.isInteger(c) || c < 1 || c > 65535) {
		draft.notes.push(`port ${raw}: unparseable, skipped`);
		return;
	}
	const pm: PortMap = { host: h, container: c };
	if (local) pm.local = true;
	draft.ports.push(pm);
}

function envMap(node: unknown, draft: ComposeDraft): void {
	if (isMap(node)) {
		for (const it of node.items) {
			const k = str(it.key);
			if (k) draft.env[k] = str(it.value);
		}
		return;
	}
	if (isSeq(node)) {
		for (const it of node.items) {
			const s = str(it);
			const eq = s.indexOf('=');
			if (eq < 0) {
				if (s) draft.notes.push(`env ${s}: host lookup unsupported, set the value explicitly`);
				continue;
			}
			draft.env[s.slice(0, eq)] = s.slice(eq + 1);
		}
		return;
	}
	draft.notes.push('environment: unparseable, skipped');
}

const HTTP_PROBE_RE =
	/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::(\d{1,5}))?(\/\S*)?/;

// healthcheck.test is a shell command; we translate the common
// curl/wget http probe and nc tcp probe, anything else is a note.
function healthcheck(node: unknown, draft: ComposeDraft): void {
	if (!isMap(node)) {
		draft.notes.push('healthcheck: unparseable, skipped');
		return;
	}
	const get = (k: string) => node.items.find((i) => str(i.key) === k)?.value;
	if (scalar(get('disable')) === true) {
		draft.notes.push('healthcheck: disabled in compose, left off');
		return;
	}
	const test = get('test');
	let cmd = '';
	if (isSeq(test)) {
		cmd = test.items.map(str).join(' ');
	} else if (test !== undefined) {
		cmd = str(test);
	}
	cmd = cmd.replace(/^(CMD-SHELL|CMD)\s+/, '');
	const hit = HTTP_PROBE_RE.exec(cmd);
	const nc = /\bnc\b[^;&|]*?\b(\d{1,5})\b/.exec(cmd);
	if (hit && /curl|wget/.test(cmd)) {
		draft.healthcheck = {
			kind: 'http',
			port: hit[1] ? Number(hit[1]) : 80,
			path: hit[2] || '/'
		};
	} else if (nc) {
		draft.healthcheck = { kind: 'tcp', port: Number(nc[1]) };
	} else if (cmd) {
		draft.notes.push(`healthcheck test ${JSON.stringify(cmd)} not translated; set it on the app`);
	}
	const interval = durationMs(str(get('interval')));
	if (interval !== null && draft.healthcheck.kind) draft.healthcheck.intervalMs = interval;
	const timeout = durationMs(str(get('timeout')));
	if (timeout !== null && draft.healthcheck.kind) draft.healthcheck.timeoutMs = timeout;
	const retries = Number(scalar(get('retries')));
	if (Number.isInteger(retries) && retries > 0 && draft.healthcheck.kind) {
		draft.healthcheck.retries = retries;
	}
}

// build: 'dir' | {context, dockerfile, args}. Only a git context can
// convert; local dirs have no repo for the agent to clone.
function buildSource(node: unknown, draft: ComposeDraft): void {
	let context = '';
	let dockerfile = '';
	if (isMap(node)) {
		for (const it of node.items) {
			const k = str(it.key);
			if (k === 'context') context = str(it.value);
			else if (k === 'dockerfile') dockerfile = str(it.value);
			else draft.unsupported.push(`build.${k}`);
		}
	} else {
		context = str(node);
	}
	const refIdx = context.indexOf('#');
	let ref = '';
	if (refIdx >= 0) {
		ref = context.slice(refIdx + 1);
		context = context.slice(0, refIdx);
	}
	if (context === '' || context === '.') {
		draft.error = 'build context is the local dir; convert to a git source with a Dockerfile';
		return;
	}
	if (!GIT_CTX_RE.test(context)) {
		draft.error = `build context ${JSON.stringify(context)} is not a git url; convert to a git source`;
		return;
	}
	draft.source = { kind: 'git', url: context, ...(ref ? { ref } : {}) };
	if (dockerfile && dockerfile !== 'Dockerfile') {
		draft.notes.push(`dockerfile ${dockerfile}: non-default name; set it on the app`);
	}
}

function service(name: string, node: unknown): ComposeDraft {
	const draft: ComposeDraft = {
		name: foldName(name),
		source: { kind: 'image', url: '' },
		env: {},
		ports: [],
		healthcheck: {},
		unsupported: [],
		notes: []
	};
	if (!isMap(node)) {
		draft.error = 'service body must be a mapping';
		return draft;
	}
	for (const it of node.items) {
		const key = str(it.key);
		const val = it.value;
		switch (key) {
			case 'image':
				draft.source = { kind: 'image', url: str(val) };
				break;
			case 'build':
				buildSource(val, draft);
				break;
			case 'ports':
				if (isSeq(val)) {
					for (const p of val.items) portMapping(p, draft);
				} else {
					draft.notes.push('ports: unparseable, skipped');
				}
				break;
			case 'expose':
				draft.notes.push('expose: informational only, ignored');
				break;
			case 'environment':
				envMap(val, draft);
				break;
			case 'healthcheck':
				healthcheck(val, draft);
				break;
			case 'depends_on':
				draft.notes.push('depends_on: start order is not enforced between apps');
				break;
			case 'restart':
				draft.notes.push('restart: policy is always unless-stopped');
				break;
			case 'container_name': {
				const n = foldName(str(val));
				if (n) draft.name = n;
				break;
			}
			case 'labels':
			case 'domainname':
				draft.notes.push(`${key}: ignored`);
				break;
			default:
				if (UNSUPPORTED_KEYS.has(key)) draft.unsupported.push(key);
				else draft.notes.push(`${key}: unknown key, ignored`);
		}
	}
	if (!draft.error && !draft.source.url) {
		draft.error = 'service has no image and no git build context';
	}
	return draft;
}

export function parseCompose(text: string): ComposePlan {
	const plan: ComposePlan = { project: '', services: [], warnings: [] };
	const doc = parseDocument(text, { uniqueKeys: true });
	if (doc.errors.length > 0) {
		plan.warnings.push(...doc.errors.map((e) => `yaml: ${e.message.split('\n')[0]}`));
		return plan;
	}
	const root = doc.contents;
	if (!isMap(root)) {
		plan.warnings.push('compose file must be a mapping with a services key');
		return plan;
	}
	const get = (k: string) => root.items.find((i) => str(i.key) === k)?.value;
	const name = str(get('name'));
	if (name) plan.project = foldName(name);
	if (get('version') !== undefined) {
		plan.warnings.push('version: obsolete key, ignored');
	}
	for (const top of ['networks', 'volumes', 'configs', 'secrets']) {
		const n = get(top);
		if (isMap(n) && n.items.length > 0) {
			plan.warnings.push(`top-level ${top}: not translated (${n.items.length} entries)`);
		}
	}
	const services = get('services');
	if (!isMap(services) || services.items.length === 0) {
		plan.warnings.push('no services found');
		return plan;
	}
	for (const it of services.items) {
		const svcName = str(it.key);
		if (!svcName) continue;
		plan.services.push(service(svcName, it.value));
	}
	return plan;
}
