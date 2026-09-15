import * as v from 'valibot';
import { EDGE_CERT_STATUSES } from '$lib/shared/edge';

// Ingest schema for agent payloads. Keep field names in sync with
// agent/internal/collect/types.go. Everything is bounded: a hostile or
// buggy agent cannot grow memory, disk rows, or the db without limit.

const Num = v.pipe(v.number(), v.minValue(0), v.maxValue(1e18));
const Pct = v.pipe(v.number(), v.minValue(0), v.maxValue(1e6));
const Int = v.pipe(v.number(), v.integer(), v.minValue(0));
const ShortStr = v.pipe(v.string(), v.maxLength(256));
const MidStr = v.pipe(v.string(), v.maxLength(1024));

const Disk = v.object({
	mount: ShortStr,
	fstype: ShortStr,
	device: v.optional(ShortStr),
	total: Num,
	used: Num,
	pct: Pct,
	inodesPct: v.optional(Pct)
});

const DiskIO = v.object({
	device: ShortStr,
	readBps: Num,
	writeBps: Num,
	util: Pct
});

const Temp = v.object({
	label: ShortStr,
	celsius: v.pipe(v.number(), v.minValue(-100), v.maxValue(500))
});

const GPU = v.object({
	vendor: ShortStr,
	name: ShortStr,
	tempC: v.optional(Pct),
	utilPct: v.optional(Pct),
	memUsed: v.optional(Num),
	memTotal: v.optional(Num),
	powerW: v.optional(Pct)
});

const NetIface = v.object({
	name: ShortStr,
	rxBps: Num,
	txBps: Num
});

const Port = v.object({
	proto: ShortStr,
	port: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(65535)),
	address: MidStr,
	process: v.optional(ShortStr)
});

const DockerContainer = v.object({
	id: ShortStr,
	name: ShortStr,
	image: MidStr,
	state: ShortStr,
	status: MidStr,
	runtime: v.optional(ShortStr),
	cpuPct: v.optional(Pct),
	memUsed: v.optional(Num),
	memLimit: v.optional(Num),
	restarts: v.optional(Int)
});

const Process = v.object({
	pid: Int,
	name: ShortStr,
	cpuPct: Pct,
	memBytes: Num
});

const ServiceState = v.object({
	name: MidStr,
	manager: ShortStr,
	state: ShortStr,
	sub: v.optional(ShortStr),
	enabled: v.optional(v.boolean())
});

const K8sPod = v.object({
	name: MidStr,
	namespace: MidStr,
	phase: ShortStr,
	restarts: Int
});

const CSDecision = v.object({
	scope: ShortStr,
	value: MidStr,
	type: ShortStr,
	scenario: MidStr
});

// Wire version floor, not an exact pin: agents newer than the hub may
// bump v and add fields we do not know yet. Valibot strips unknown
// keys, so accepting v >= 1 keeps newer agents talking to older hubs
// (Beszel-style compat) while v < 1 is still rejected outright.
const WireVersion = v.pipe(v.number(), v.integer(), v.minValue(1));

export const AgentPayload = v.object({
	v: WireVersion,
	fingerprint: v.optional(v.pipe(v.string(), v.maxLength(128)), ''),
	ts: v.pipe(v.number(), v.integer(), v.minValue(0)),
	// Buffered sample delivered late after a hub outage; relaxes the
	// clock-skew check server-side to a bounded catch-up window.
	backfill: v.optional(v.boolean(), false),
	agent: v.object({
		version: ShortStr,
		hostname: ShortStr,
		os: ShortStr,
		arch: ShortStr,
		kernel: v.optional(ShortStr),
		uptimeSec: Num,
		name: v.optional(ShortStr),
		// Advertised protocol features; informational only, the hub
		// never requires specific caps to accept a payload.
		caps: v.optional(v.pipe(v.array(ShortStr), v.maxLength(32)))
	}),
	cpu: v.object({
		pct: Pct,
		cores: Int,
		load1: Pct,
		load5: Pct,
		load15: Pct,
		perCore: v.optional(v.pipe(v.array(Pct), v.maxLength(1024))),
		freqMhz: v.optional(Num)
	}),
	mem: v.object({
		total: Num,
		used: Num,
		available: Num,
		pct: Pct,
		swapTotal: Num,
		swapUsed: Num
	}),
	disks: v.optional(v.pipe(v.array(Disk), v.maxLength(256))),
	diskIO: v.optional(v.pipe(v.array(DiskIO), v.maxLength(256))),
	temps: v.optional(v.pipe(v.array(Temp), v.maxLength(512))),
	gpus: v.optional(v.pipe(v.array(GPU), v.maxLength(64))),
	net: v.object({
		rxBps: Num,
		txBps: Num,
		interfaces: v.optional(v.pipe(v.array(NetIface), v.maxLength(128))),
		addresses: v.optional(v.pipe(v.array(MidStr), v.maxLength(64)))
	}),
	connections: v.object({
		established: Int,
		listen: Int,
		timeWait: Int,
		udp: Int,
		total: Int
	}),
	ports: v.optional(v.pipe(v.array(Port), v.maxLength(2048))),
	docker: v.optional(
		v.object({
			running: Int,
			total: Int,
			containers: v.optional(v.pipe(v.array(DockerContainer), v.maxLength(1024)))
		})
	),
	services: v.optional(v.pipe(v.array(ServiceState), v.maxLength(2048))),
	processes: v.optional(v.pipe(v.array(Process), v.maxLength(16))),
	security: v.object({
		ufw: v.optional(
			v.object({
				enabled: v.boolean(),
				default: v.optional(MidStr),
				rules: Int,
				bypassed: v.optional(v.pipe(v.array(ShortStr), v.maxLength(256)))
			})
		),
		// firewalld mirrors ufw for hosts that run it instead. Bypassed
		// lists published container ports no zone covers (runtimes
		// program their own NAT and slip past firewalld filtering).
		firewalld: v.optional(
			v.object({
				enabled: v.boolean(),
				default: v.optional(MidStr),
				zones: v.optional(v.pipe(v.array(ShortStr), v.maxLength(64))),
				ports: v.optional(v.pipe(v.array(ShortStr), v.maxLength(256))),
				richRules: Int,
				bypassed: v.optional(v.pipe(v.array(ShortStr), v.maxLength(256)))
			})
		),
		fail2ban: v.optional(
			v.object({
				enabled: v.boolean(),
				jails: v.optional(
					v.pipe(
						v.array(
							v.object({
								name: ShortStr,
								banned: Int,
								bannedIps: v.optional(v.pipe(v.array(ShortStr), v.maxLength(10000)))
							})
						),
						v.maxLength(128)
					)
				)
			})
		),
		crowdsec: v.optional(
			v.object({
				enabled: v.boolean(),
				decisions: Int,
				alerts: Int,
				bans: v.optional(v.pipe(v.array(CSDecision), v.maxLength(256)))
			})
		)
	}),
	k8s: v.optional(
		v.object({
			pods: Int,
			running: Int,
			pending: Int,
			failed: Int,
			succeeded: Int,
			restarts: Int,
			podList: v.optional(v.pipe(v.array(K8sPod), v.maxLength(256)))
		})
	),
	traefik: v.optional(
		v.object({
			httpRouters: Int,
			httpServices: Int,
			middlewares: Int,
			tcpRouters: Int,
			tcpServices: Int,
			udpRouters: Int,
			routerErrors: Int,
			routerWarnings: Int
		})
	),
	reticulum: v.optional(
		v.object({
			running: v.boolean(),
			flavor: v.optional(ShortStr),
			version: v.optional(ShortStr),
			identity: v.optional(ShortStr),
			uptimeSec: v.optional(Int),
			interfaces: v.optional(
				v.pipe(
					v.array(
						v.object({
							name: ShortStr,
							type: v.optional(ShortStr),
							status: ShortStr,
							mode: v.optional(ShortStr),
							clients: v.optional(Int),
							rxBytes: v.optional(Int),
							txBytes: v.optional(Int)
						})
					),
					v.maxLength(64)
				)
			),
			paths: v.optional(Int),
			findings: v.optional(v.pipe(v.array(MidStr), v.maxLength(16)))
		})
	),
	// Login/ssh activity: who sessions, recent sshd auth events, and
	// failure stats. partial/note flag an unreadable log source so the
	// panel can say "insufficient permissions" instead of showing
	// silence.
	logins: v.optional(
		v.object({
			sessions: v.optional(
				v.pipe(
					v.array(
						v.object({
							user: ShortStr,
							tty: ShortStr,
							from: v.optional(ShortStr),
							since: v.optional(ShortStr)
						})
					),
					v.maxLength(64)
				)
			),
			events: v.optional(
				v.pipe(
					v.array(
						v.object({
							ts: ShortStr,
							kind: ShortStr,
							user: ShortStr,
							src: ShortStr,
							method: v.optional(ShortStr)
						})
					),
					v.maxLength(64)
				)
			),
			remote: Int,
			failed24h: Int,
			topFailed: v.optional(
				v.pipe(v.array(v.object({ src: ShortStr, count: Int })), v.maxLength(16))
			),
			partial: v.optional(v.boolean()),
			note: v.optional(MidStr)
		})
	),
	// Edge-proxy TLS inventory; populated by agents running -edge.
	edgeCerts: v.optional(
		v.pipe(
			v.array(
				v.object({
					host: ShortStr,
					expiresAt: Int,
					issuer: ShortStr,
					status: v.picklist(EDGE_CERT_STATUSES)
				})
			),
			v.maxLength(256)
		)
	)
});

export type AgentPayload = v.InferOutput<typeof AgentPayload>;

// Edge traffic report from the traefik plugin (or any edge probe).
// Bounded everywhere so a busy edge cannot grow the db without limit.
export const EdgeReport = v.object({
	v: WireVersion,
	ts: v.pipe(v.number(), v.integer(), v.minValue(0)),
	windowSec: v.pipe(v.number(), v.minValue(1), v.maxValue(3600)),
	requests: Int,
	s2xx: Int,
	s3xx: Int,
	s4xx: Int,
	s5xx: Int,
	latencyP50: v.optional(Num),
	latencyP95: v.optional(Num),
	latencyP99: v.optional(Num),
	clients: v.optional(v.pipe(v.array(v.object({ ip: ShortStr, requests: Int })), v.maxLength(64))),
	paths: v.optional(
		v.pipe(v.array(v.object({ path: MidStr, requests: Int, errors: Int })), v.maxLength(128))
	),
	errors: v.optional(
		v.pipe(
			v.array(
				v.object({
					ts: Int,
					method: ShortStr,
					host: MidStr,
					path: MidStr,
					status: Int,
					ip: ShortStr
				})
			),
			v.maxLength(128)
		)
	)
});

export type EdgeReport = v.InferOutput<typeof EdgeReport>;
