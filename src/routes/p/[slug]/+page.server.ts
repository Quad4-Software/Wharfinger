import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { filterSnapshot } from '$lib/shared/pages';

export const load: PageServerLoad = async ({ params, setHeaders }) => {
	const rt = getRuntime();
	const { snapshot } = await rt.snapshot.current();
	const meta = snapshot.pages.find((p) => p.slug === params.slug);
	if (!meta) error(404, 'unknown status page');
	if (meta.noindex) {
		setHeaders({ 'x-robots-tag': 'noindex, nofollow, noarchive' });
	}
	return { snapshot: filterSnapshot(snapshot, meta), page: meta };
};
