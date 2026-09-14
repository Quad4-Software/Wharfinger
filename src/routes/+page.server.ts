import type { PageServerLoad } from './$types';
import { getRuntime } from '$lib/server/runtime';

export const load: PageServerLoad = () => {
	// SSR embeds the current snapshot so first paint is instant and works
	// with JS disabled; the client then subscribes to /api/stream.
	return { snapshot: getRuntime().snapshot.current().snapshot };
};
