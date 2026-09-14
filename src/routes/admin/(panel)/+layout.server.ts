import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

// Belt-and-suspenders: hooks.server.ts already redirects anonymous
// visitors, but never serve panel data without a user.
export const load: LayoutServerLoad = ({ locals, url }) => {
	if (!locals.user) {
		const next = encodeURIComponent(url.pathname + url.search);
		redirect(303, `${locals.adminBase}/login?next=${next}`);
	}
	return { user: locals.user, perms: [...(locals.perms ?? [])] };
};
