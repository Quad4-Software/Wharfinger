import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '$lib/server/store/db';
import { AgentStore, type AgentRow } from '$lib/server/ingress/agents';
import { AgentAlerter } from '$lib/server/ingress/alerts';
import { AgentPayload } from '$lib/server/ingress/schema';
import { IngressSection, type StatusConfig } from '$lib/server/config/schema';
import type { NotifyDispatcher } from '$lib/server/notify/dispatcher';
import type { NotifyContext } from '$lib/server/notify/templates';

function freshDb(): DatabaseSync {
	return openDb(mkdtempSync(join(tmpdir(), 'wharfinger-alerts-')));
}

type Sent = Omit<NotifyContext, 'siteName' | 'siteUrl'>;

function fakeDispatcher(sent: Sent[]): NotifyDispatcher {
	return {
		notify: vi.fn((ctx: Sent) => {
			sent.push(ctx);
			return Promise.resolve();
		})
	} as unknown as NotifyDispatcher;
}

function cfgWith(ingress: Partial<StatusConfig['ingress']>): StatusConfig {
	// The alerter only reads cfg.ingress; a partial cast keeps the
	// fixture focused instead of rebuilding a whole StatusConfig.
	return { ingress: v.parse(IngressSection, ingress) } as StatusConfig;
}

function payload(over: Record<string, unknown> = {}) {
	return v.parse(AgentPayload, {
		v: 1,
		fingerprint: 'fp',
		ts: Date.now(),
		agent: { version: '0.1.0', hostname: 'h1', os: 'linux', arch: 'amd64', uptimeSec: 60 },
		cpu: { pct: 12, cores: 8, load1: 0.5, load5: 0.4, load15: 0.3 },
		mem: { total: 1e9, used: 5e8, available: 5e8, pct: 50, swapTotal: 0, swapUsed: 0 },
		disks: [{ mount: '/', fstype: 'ext4', total: 1e9, used: 5e8, pct: 50 }],
		net: { rxBps: 1, txBps: 1 },
		connections: { established: 0, listen: 0, timeWait: 0, udp: 0, total: 0 },
		security: {},
		...over
	});
}

function setup(ingress: Partial<StatusConfig['ingress']> = {}) {
	const db = freshDb();
	const agents = new AgentStore(db);
	const sent: Sent[] = [];
	const alerter = new AgentAlerter(() => cfgWith(ingress), agents, fakeDispatcher(sent));
	return { db, agents, sent, alerter };
}

describe('AgentAlerter thresholds', () => {
	it('fires degraded once at the threshold and recovers below hysteresis', () => {
		const { agents, sent, alerter } = setup({ alert_cpu_pct: 90 });
		const { id } = agents.create('web-1', null);
		const agent = (): AgentRow => agents.get(id)!;

		alerter.onSample(
			agent(),
			payload({ cpu: { pct: 95, cores: 8, load1: 1, load5: 1, load15: 1 } })
		);
		expect(sent).toHaveLength(1);
		expect(sent[0].event).toBe('degraded');
		expect(sent[0].serviceId).toBe(`agent:${id}`);
		expect(sent[0].detail).toContain('CPU at 95.0%');

		// Still firing: no repeat notification while above the clear line.
		alerter.onSample(
			agent(),
			payload({ cpu: { pct: 85, cores: 8, load1: 1, load5: 1, load15: 1 } })
		);
		expect(sent).toHaveLength(1);

		// Below threshold - 10 clears with a recovery.
		alerter.onSample(
			agent(),
			payload({ cpu: { pct: 50, cores: 8, load1: 1, load5: 1, load15: 1 } })
		);
		expect(sent).toHaveLength(2);
		expect(sent[1].event).toBe('recovered');
		expect(agents.get(id)!.alerts).toEqual({});
	});

	it('uses the worst disk for the disk rule and ignores unset rules', () => {
		const { agents, sent, alerter } = setup({ alert_disk_pct: 80 });
		const { id } = agents.create('db-1', null);
		alerter.onSample(
			agents.get(id)!,
			payload({
				disks: [
					{ mount: '/', fstype: 'x', total: 10, used: 5, pct: 50 },
					{ mount: '/data', fstype: 'x', total: 10, used: 9, pct: 91 }
				]
			})
		);
		expect(sent).toHaveLength(1);
		expect(sent[0].detail).toContain('disk at 91.0%');

		// cpu/mem rules are unset: a hot cpu alone notifies nothing.
		const { id: id2 } = agents.create('hot', null);
		alerter.onSample(
			agents.get(id2)!,
			payload({ cpu: { pct: 99, cores: 1, load1: 1, load5: 1, load15: 1 } })
		);
		expect(sent).toHaveLength(1);
	});

	it('clears a firing rule silently when the rule is disabled', () => {
		const db = freshDb();
		const agents = new AgentStore(db);
		const sent: Sent[] = [];
		let on = true;
		const alerter = new AgentAlerter(
			() => cfgWith({ alert_cpu_pct: on ? 90 : 0 }),
			agents,
			fakeDispatcher(sent)
		);
		const { id } = agents.create('web', null);
		alerter.onSample(
			agents.get(id)!,
			payload({ cpu: { pct: 95, cores: 1, load1: 0, load5: 0, load15: 0 } })
		);
		expect(sent).toHaveLength(1);
		on = false;
		alerter.onSample(
			agents.get(id)!,
			payload({ cpu: { pct: 95, cores: 1, load1: 0, load5: 0, load15: 0 } })
		);
		expect(sent).toHaveLength(1); // no recovery notification for a disabled rule
		expect(agents.get(id)!.alerts).toEqual({});
	});
});

describe('AgentAlerter offline detection', () => {
	it('fires down after the silence window and recovered on the next sample', () => {
		const { db, agents, sent, alerter } = setup({ alert_offline_minutes: 10 });
		const { id } = agents.create('nas', null);
		db.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?').run(Date.now() - 11 * 60_000, id);
		alerter.tick();
		expect(sent).toHaveLength(1);
		expect(sent[0].event).toBe('down');
		expect(sent[0].detail).toContain('no metrics for 11 min');
		expect(agents.get(id)!.alerts.offline).toBeTypeOf('number');

		// A second tick does not re-fire.
		alerter.tick();
		expect(sent).toHaveLength(1);

		// The agent reporting again clears the alert with a recovery.
		alerter.onSample(agents.get(id)!, payload());
		expect(sent).toHaveLength(2);
		expect(sent[1].event).toBe('recovered');
		expect(agents.get(id)!.alerts).toEqual({});
	});

	it('skips agents inside the window, never-seen agents, and revoked agents', () => {
		const { db, agents, sent, alerter } = setup({ alert_offline_minutes: 10 });
		const fresh = agents.create('fresh', null);
		db.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?').run(
			Date.now() - 60_000,
			fresh.id
		);
		agents.create('never-seen', null); // last_seen_at stays null
		const dead = agents.create('dead', null);
		db.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?').run(
			Date.now() - 3600_000,
			dead.id
		);
		agents.revoke(dead.id);

		alerter.tick();
		expect(sent).toHaveLength(0);
	});

	it('does nothing when the offline rule is disabled', () => {
		const { db, agents, sent, alerter } = setup({ alert_offline_minutes: 0 });
		const { id } = agents.create('nas', null);
		db.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?').run(Date.now() - 86400_000, id);
		alerter.tick();
		expect(sent).toHaveLength(0);
	});
});
