import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import UptimeBars from '$lib/components/UptimeBars.svelte';
import type { DayBucket } from '$lib/shared/types';

const days: DayBucket[] = [
	{ date: '2026-09-11', state: 'up', uptime: 100, checks: 10 },
	{ date: '2026-09-12', state: 'down', uptime: 40, checks: 10 },
	{ date: '2026-09-13', state: 'nodata', uptime: null, checks: 0 }
];

describe('UptimeBars', () => {
	it('renders one bar per day with accessible labels', () => {
		render(UptimeBars, { props: { days } });
		const bars = screen.getAllByRole('listitem');
		expect(bars).toHaveLength(3);
		expect(bars[0]).toHaveAccessibleName(/2026-09-11: Operational, 100\.00% uptime/);
		expect(bars[1]).toHaveAccessibleName(/Major disruption/);
		expect(bars[2]).toHaveAccessibleName(/No data/);
	});
});
