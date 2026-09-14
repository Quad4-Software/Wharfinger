import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { filterSnapshot } from '$lib/shared/pages';

export const load: PageServerLoad = ({ params, setHeaders }) => {
	const rt = getRuntime();
	const meta = rt.snapshot.current().snapshot.pages.find((p) => p.slug === params.slug);
	if (!meta) error(404, 'unknown status page');
	if (meta.noindex) {
		setHeaders({ 'x-robots-tag': 'noindex, nofollow, noarchive' });
	}
	return { snapshot: filterSnapshot(rt.snapshot.current().snapshot, meta), page: meta };
};
