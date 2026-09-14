import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import StatusPill from '$lib/components/StatusPill.svelte';

describe('StatusPill', () => {
	it('renders the label for each status', () => {
		render(StatusPill, { props: { status: 'operational' } });
		expect(screen.getByText('Operational')).toBeInTheDocument();
	});

	it('shows outage label', () => {
		render(StatusPill, { props: { status: 'major_outage' } });
		expect(screen.getByText('Major Outage')).toBeInTheDocument();
	});
});
