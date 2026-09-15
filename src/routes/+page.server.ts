import type { PageServerLoad } from './$types';
import { getRuntime } from '$lib/server/runtime';

export const load: PageServerLoad = async () => {
	// SSR embeds the current snapshot so first paint is instant and works
	// with JS disabled; the client then subscribes to /api/stream.
	return { snapshot: (await getRuntime().snapshot.current()).snapshot };
};
