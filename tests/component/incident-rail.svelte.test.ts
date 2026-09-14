import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import IncidentRail from '$lib/components/IncidentRail.svelte';
import type { Incident } from '$lib/shared/types';

const incidents: Incident[] = [
	{
		id: 'inc-1',
		title: 'Elevated API latency',
		severity: 'minor',
		services: ['Push'],
		startedAt: '2026-09-10T12:00:00Z',
		resolvedAt: '2026-09-10T13:30:00Z',
		updates: [{ at: '2026-09-10T12:10:00Z', message: 'Investigating' }],
		source: 'auto'
	},
	{
		id: 'inc-2',
		title: 'Database failover',
		severity: 'major',
		services: ['Chat', 'Socket'],
		startedAt: '2026-09-08T03:00:00Z',
		resolvedAt: '2026-09-08T03:45:00Z',
		updates: [],
		source: 'manual'
	}
];

describe('IncidentRail', () => {
	it('renders each incident with its resolution', () => {
		render(IncidentRail, { props: { incidents } });
		expect(screen.getByRole('region', { name: 'Past incidents' })).toBeInTheDocument();
		expect(screen.getByText('Elevated API latency')).toBeInTheDocument();
		expect(screen.getByText('Database failover')).toBeInTheDocument();
		expect(screen.getAllByText(/resolved after/).length).toBeGreaterThan(0);
	});

	it('wraps incidents with updates in an expandable details element', () => {
		render(IncidentRail, { props: { incidents } });
		const summary = screen.getByText('Elevated API latency').closest('summary');
		expect(summary).not.toBeNull();
		expect(summary!.parentElement!.tagName).toBe('DETAILS');
		// The incident without updates renders as a plain block.
		expect(screen.getByText('Database failover').closest('details')).toBeNull();
	});

	it('shows a friendly empty state', () => {
		render(IncidentRail, { props: { incidents: [] } });
		expect(screen.getByText('No incidents on record.')).toBeInTheDocument();
	});
});
