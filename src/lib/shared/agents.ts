// Types shared between the ingress admin API and the panel UI.

import type { EdgeCertInfo } from './edge';

interface AgentSummary {
	cpuPct: number;
	memPct: number;
	diskPct: number | null;
	rxBps: number;
	txBps: number;
	load1: number;
	cores: number;
	uptimeSec: number;
	tempMax: number | null;
	containers: { running: number; total: number } | null;
	servicesFailed: number | null;
	/** Package-manager posture from the updates collector. */
	updates?: {
		manager: string;
		pending: number;
		security: number;
		rebootRequired: boolean | null;
	} | null;
}

export interface AgentMeta {
	version?: string;
	hostname?: string;
	os?: string;
	arch?: string;
	kernel?: string;
	uptimeSec?: number;
	/** Advertised protocol capabilities, e.g. ['v1','backfill']. */
	caps?: string[] | null;
}

export interface AgentView {
	id: string;
	name: string;
	fingerprintBound: boolean;
	/** Identity key bound; false on a seen agent means a legacy client. */
	keyBound: boolean;
	createdAt: number;
	createdBy: string | null;
	lastSeenAt: number | null;
	online: boolean;
	revoked: boolean;
	/** Active alert rule keys, e.g. ['offline', 'cpu']. */
	alerts: string[];
	/** Offline-alert silence window (scheduled reboot); null or a
	    future epoch ms. */
	mutedUntil: number | null;
	meta: AgentMeta | null;
	summary: AgentSummary | null;
}

export interface AgentSample {
	ts: number;
	cpu: number | null;
	mem_pct: number | null;
	disk_pct: number | null;
	rx_bps: number | null;
	tx_bps: number | null;
	load1: number | null;
	temp_max: number | null;
	mem_used: number | null;
	disk_used: number | null;
}

interface AgentDisk {
	mount: string;
	fstype: string;
	device?: string;
	total: number;
	used: number;
	pct: number;
	inodesPct?: number;
}

interface AgentTemp {
	label: string;
	celsius: number;
}

interface AgentGpu {
	vendor: string;
	name: string;
	tempC?: number;
	utilPct?: number;
	memUsed?: number;
	memTotal?: number;
	powerW?: number;
}

export interface AgentContainer {
	id: string;
	name: string;
	image: string;
	state: string;
	status: string;
	runtime?: string;
	cpuPct?: number;
	memUsed?: number;
	memLimit?: number;
	restarts?: number;
}

export interface AgentService {
	name: string;
	manager: string;
	state: string;
	sub?: string;
	enabled?: boolean;
}

export interface AgentProcess {
	pid: number;
	name: string;
	cpuPct: number;
	memBytes: number;
}

interface AgentPort {
	proto: string;
	port: number;
	address: string;
	process?: string;
}

export interface K8sPodView {
	name: string;
	namespace: string;
	phase: string;
	restarts: number;
}

interface K8sView {
	pods: number;
	running: number;
	pending: number;
	failed: number;
	succeeded: number;
	restarts: number;
	podList?: K8sPodView[];
}

interface TraefikView {
	httpRouters: number;
	httpServices: number;
	middlewares: number;
	tcpRouters: number;
	tcpServices: number;
	udpRouters: number;
	routerErrors: number;
	routerWarnings: number;
}

export interface EdgeSampleView {
	ts: number;
	windowSec: number;
	requests: number;
	s2xx: number;
	s3xx: number;
	s4xx: number;
	s5xx: number;
	errs: number;
}

export interface EdgeReportView {
	v: 1;
	ts: number;
	windowSec: number;
	requests: number;
	s2xx: number;
	s3xx: number;
	s4xx: number;
	s5xx: number;
	latencyP50?: number;
	latencyP95?: number;
	latencyP99?: number;
	clients?: { ip: string; requests: number }[];
	paths?: { path: string; requests: number; errors: number }[];
	errors?: { ts: number; method: string; host: string; path: string; status: number; ip: string }[];
}

// Client-side mirror of the ingest payload (server validates against
// the valibot schema in server/ingress/schema.ts). Optional sections
// arrive absent when the collector could not run on the host.
export interface AgentPayloadView {
	v: 1;
	fingerprint: string;
	ts: number;
	agent: {
		version: string;
		hostname: string;
		os: string;
		arch: string;
		kernel?: string;
		uptimeSec: number;
	};
	cpu: {
		pct: number;
		cores: number;
		load1: number;
		load5: number;
		load15: number;
		perCore?: number[];
		freqMhz?: number;
	};
	mem: {
		total: number;
		used: number;
		available: number;
		pct: number;
		swapTotal: number;
		swapUsed: number;
	};
	disks?: AgentDisk[];
	diskIO?: { device: string; readBps: number; writeBps: number; util: number }[];
	temps?: AgentTemp[];
	gpus?: AgentGpu[];
	net: {
		rxBps: number;
		txBps: number;
		interfaces?: { name: string; rxBps: number; txBps: number }[];
	};
	connections: {
		established: number;
		listen: number;
		timeWait: number;
		udp: number;
		total: number;
	};
	ports?: AgentPort[];
	docker?: { running: number; total: number; containers?: AgentContainer[] };
	services?: AgentService[];
	processes?: AgentProcess[];
	security: {
		ufw?: { enabled: boolean; default?: string; rules: number; bypassed?: string[] };
		firewalld?: {
			enabled: boolean;
			default?: string;
			zones?: string[];
			ports?: string[];
			richRules: number;
			bypassed?: string[];
		};
		fail2ban?: {
			enabled: boolean;
			jails?: { name: string; banned: number; bannedIps?: string[] }[];
		};
		crowdsec?: {
			enabled: boolean;
			decisions: number;
			alerts: number;
			bans?: { scope: string; value: string; type: string; scenario: string }[];
		};
	};
	k8s?: K8sView;
	traefik?: TraefikView;
	reticulum?: ReticulumView;
	logins?: LoginsView;
	edgeCerts?: EdgeCertInfo[];
	/** OS package posture: pending + security update counts and the
	    reboot-required flag, when the collector found a package
	    manager. */
	updates?: {
		manager: string;
		pending: number;
		security: number;
		rebootRequired?: boolean;
	};
}

// Reticulum node state from the agent collector: daemon liveness,
// transport identity, interface table, and rgoslow findings.
interface ReticulumView {
	running: boolean;
	flavor?: string;
	version?: string;
	identity?: string;
	uptimeSec?: number;
	interfaces?: {
		name: string;
		type?: string;
		status: string;
		mode?: string;
		clients?: number;
		rxBytes?: number;
		txBytes?: number;
	}[];
	paths?: number;
	findings?: string[];
}

// Login/ssh activity: interactive sessions plus recent sshd auth
// events. partial+note mean the agent could not read the journal or
// auth log, so an empty event list is a permission gap, not silence.
interface LoginsView {
	sessions?: { user: string; tty: string; from?: string; since?: string }[];
	events?: { ts: string; kind: string; user: string; src: string; method?: string }[];
	remote: number;
	failed24h: number;
	topFailed?: { src: string; count: number }[];
	partial?: boolean;
	note?: string;
}
