import { describe, expect, it } from 'vitest';
import { ServiceState } from '$lib/server/monitor/service-state';
import type { CheckOutcome } from '$lib/server/monitor/checkers';

const up: CheckOutcome = { ok: true, degraded: false, latencyMs: 10 };
const slow: CheckOutcome = { ok: true, degraded: true, latencyMs: 5000 };
const down: CheckOutcome = { ok: false, degraded: false, latencyMs: 10 };

describe('ServiceState flap protection', () => {
	it('does not go down on a single failure', () => {
		const s = new ServiceState(2, 2);
		s.apply(up); // establishes operational
		expect(s.status).toBe('operational');
		expect(s.apply(down)).toBeNull(); // 1 failure < threshold
		expect(s.apply(down)).toBe('major_outage');
	});

	it('requires consecutive successes to recover', () => {
		const s = new ServiceState(2, 2);
		s.apply(down);
		s.apply(down);
		expect(s.status).toBe('major_outage');
		expect(s.apply(up)).toBeNull();
		expect(s.apply(up)).toBe('operational');
	});

	it('treats degraded streaks as degraded, not outage', () => {
		const s = new ServiceState(2, 2);
		s.apply(up);
		s.apply(up);
		s.apply(slow);
		expect(s.apply(slow)).toBe('degraded');
	});

	it('resets streaks on opposite result', () => {
		const s = new ServiceState(2, 2);
		s.apply(up);
		s.apply(up);
		s.apply(down);
		s.apply(up); // resets bad streak
		s.apply(down);
		expect(s.status).toBe('operational');
		expect(s.apply(down)).toBe('major_outage');
	});
});
