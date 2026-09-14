import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => {
	return {
		user: locals.user,
		adminBase: locals.adminBase,
		noindex: true
	};
};
