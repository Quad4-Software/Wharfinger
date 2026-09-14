import { classifyDay, type DayState } from './status';
import type { DayBucket } from './types';

// Pure uptime math shared by the snapshot builder and unit tests.
// All inputs are plain rows so these functions never touch the database.

export interface CheckRow {
	/** Unix ms timestamp. */
	ts: number;
	/** 1 = healthy, 0 = failed. */
	ok: number;
	latencyMs: number;
}

export interface TimeWindow {
	/** Unix ms. */
	start: number;
	/** Unix ms. */
	end: number;
}

export function uptimePercent(checks: CheckRow[]): number | null {
	if (checks.length === 0) return null;
	const up = checks.reduce((acc, c) => acc + c.ok, 0);
	return round2((up / checks.length) * 100);
}

/**
 * Fraction of ok rows with ts >= from, mirroring the store's
 * SUM(ok)/COUNT(*) aggregate. Returns null when nothing matches. Used
 * by the snapshot builder to reuse already-fetched rows instead of
 * re-querying per window.
 */
export function uptimeFractionInRows(checks: CheckRow[], from: number): number | null {
	let ok = 0;
	let n = 0;
	// Rows are ts-ascending; walking back stops at the window edge.
	for (let i = checks.length - 1; i >= 0; i--) {
		const c = checks[i];
		if (c.ts < from) break;
		n++;
		ok += c.ok;
	}
	return n > 0 ? ok / n : null;
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

const DAY_MS = 86_400_000;

function dayKey(ts: number, tzOffsetMs: number): string {
	return new Date(ts + tzOffsetMs).toISOString().slice(0, 10);
}

/**
 * Build `days` daily buckets ending at the day containing `now`, oldest
 * first. `checks` must be sorted ascending by ts and already filtered to
 * the relevant range. `maintenance` windows mark covered days.
 */
export function buildDayBuckets(opts: {
	now: number;
	days: number;
	checks: CheckRow[];
	maintenance: TimeWindow[];
	tzOffsetMs?: number;
}): DayBucket[] {
	const { now, days, checks, maintenance } = opts;
	const tz = opts.tzOffsetMs ?? 0;
	// Start of the day containing `now` in display timezone.
	const todayStart = Math.floor((now + tz) / DAY_MS) * DAY_MS - tz;
	const firstDay = todayStart - (days - 1) * DAY_MS;

	// Group checks by day index.
	const perDay = new Map<number, { total: number; up: number }>();
	for (const c of checks) {
		if (c.ts < firstDay || c.ts > now) continue;
		const idx = Math.floor((c.ts - firstDay) / DAY_MS);
		const d = perDay.get(idx) ?? { total: 0, up: 0 };
		d.total += 1;
		d.up += c.ok;
		perDay.set(idx, d);
	}

	const out: DayBucket[] = [];
	for (let i = 0; i < days; i++) {
		const dayStart = firstDay + i * DAY_MS;
		const dayEnd = dayStart + DAY_MS;
		const d = perDay.get(i);
		const fraction = d && d.total > 0 ? d.up / d.total : null;
		const fullDayMaintenance = maintenance.some((w) => w.start <= dayStart && w.end >= dayEnd);
		const state: DayState = fullDayMaintenance ? 'maintenance' : classifyDay(fraction);
		out.push({
			date: dayKey(dayStart, tz),
			state,
			uptime: fraction === null ? null : round2(fraction * 100),
			checks: d?.total ?? 0
		});
	}
	return out;
}

/**
 * Bucket raw checks into fixed-size time buckets for latency charts.
 * Empty buckets are emitted with avg/min/max = null so charts can gap.
 */
export function buildLatencySeries(opts: {
	checks: CheckRow[];
	start: number;
	end: number;
	buckets: number;
}): { t: number; avg: number | null; min: number | null; max: number | null }[] {
	const { checks, start, end, buckets } = opts;
	const width = (end - start) / buckets;
	const agg = Array.from({ length: buckets }, () => ({ sum: 0, n: 0, min: Infinity, max: 0 }));
	for (const c of checks) {
		const i = Math.min(buckets - 1, Math.floor((c.ts - start) / width));
		if (i < 0) continue;
		const b = agg[i];
		b.sum += c.latencyMs;
		b.n += 1;
		if (c.latencyMs < b.min) b.min = c.latencyMs;
		if (c.latencyMs > b.max) b.max = c.latencyMs;
	}
	return agg.map((b, i) => ({
		t: Math.round(start + i * width),
		avg: b.n ? Math.round(b.sum / b.n) : null,
		min: b.n ? b.min : null,
		max: b.n ? b.max : null
	}));
}

export const LATENCY_RANGES = {
	'24h': { ms: 24 * 3600_000, buckets: 144 },
	'7d': { ms: 7 * 24 * 3600_000, buckets: 168 },
	'30d': { ms: 30 * 24 * 3600_000, buckets: 180 }
} as const;

export type LatencyRange = keyof typeof LATENCY_RANGES;
