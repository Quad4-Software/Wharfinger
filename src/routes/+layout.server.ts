import type { LayoutServerLoad } from './$types';

// locals.lang is resolved in hooks.server.ts before routing; passing
// it through page data lets the client hydrate the same locale the
// server rendered, so there is no markup mismatch.
export const load: LayoutServerLoad = ({ locals }) => {
	return { lang: locals.lang };
};
