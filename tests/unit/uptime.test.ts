import { describe, expect, it } from 'vitest';
import { buildDayBuckets, buildLatencySeries, uptimePercent } from '$lib/shared/uptime';
import { classifyDay } from '$lib/shared/status';

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-13T12:00:00Z');

function checksFor(
	dayIdx: number,
	oks: boolean[],
	dayStart: number
): { ts: number; ok: number; latencyMs: number }[] {
	return oks.map((ok, i) => ({
		ts: dayStart + dayIdx * DAY + i * 60_000,
		ok: ok ? 1 : 0,
		latencyMs: 100
	}));
}

describe('uptimePercent', () => {
	it('returns null for no checks', () => {
		expect(uptimePercent([])).toBeNull();
	});
	it('computes percentage', () => {
		expect(
			uptimePercent([
				{ ts: 1, ok: 1, latencyMs: 1 },
				{ ts: 2, ok: 0, latencyMs: 1 }
			])
		).toBe(50);
	});
});

describe('classifyDay', () => {
	it('classifies thresholds', () => {
		expect(classifyDay(null)).toBe('nodata');
		expect(classifyDay(1)).toBe('up');
		expect(classifyDay(0.95)).toBe('degraded');
		expect(classifyDay(0.5)).toBe('down');
	});
});

describe('buildDayBuckets', () => {
	it('produces days buckets oldest first ending today', () => {
		const buckets = buildDayBuckets({ now: NOW, days: 5, checks: [], maintenance: [] });
		expect(buckets).toHaveLength(5);
		expect(buckets.at(-1)?.date).toBe('2026-09-13');
		expect(buckets[0].date).toBe('2026-09-09');
		expect(buckets.every((b) => b.state === 'nodata')).toBe(true);
	});

	it('counts up and down days', () => {
		const firstDayStart = Math.floor(NOW / DAY) * DAY - 4 * DAY;
		const checks = [
			...checksFor(0, [true, true, true], firstDayStart),
			...checksFor(1, [true, false, false, false], firstDayStart)
		];
		const buckets = buildDayBuckets({ now: NOW, days: 5, checks, maintenance: [] });
		expect(buckets[0].state).toBe('up');
		expect(buckets[0].uptime).toBe(100);
		expect(buckets[1].state).toBe('down');
		expect(buckets[1].uptime).toBe(25);
		expect(buckets[4].state).toBe('nodata'); // today, no checks yet
	});

	it('marks fully covered days as maintenance', () => {
		const firstDayStart = Math.floor(NOW / DAY) * DAY - 4 * DAY;
		const buckets = buildDayBuckets({
			now: NOW,
			days: 5,
			checks: checksFor(2, [false, false], firstDayStart),
			maintenance: [{ start: firstDayStart + 2 * DAY, end: firstDayStart + 3 * DAY }]
		});
		expect(buckets[2].state).toBe('maintenance');
	});
});

describe('buildLatencySeries', () => {
	it('buckets and leaves gaps null', () => {
		const start = NOW - 10_000;
		const checks = [
			{ ts: start + 100, ok: 1, latencyMs: 100 },
			{ ts: start + 200, ok: 1, latencyMs: 200 },
			{ ts: start + 9_900, ok: 1, latencyMs: 500 }
		];
		const series = buildLatencySeries({ checks, start, end: NOW, buckets: 10 });
		expect(series).toHaveLength(10);
		expect(series[0].avg).toBe(150);
		expect(series[0].min).toBe(100);
		expect(series[0].max).toBe(200);
		expect(series[5].avg).toBeNull();
		expect(series[9].avg).toBe(500);
	});
});
