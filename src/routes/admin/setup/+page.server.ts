import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getRuntime } from '$lib/server/runtime';

// First-run setup only exists while the users table is empty; once an
// account exists this route sends visitors to the sign-in page.
export const load: PageServerLoad = ({ locals }) => {
	if (locals.user) redirect(303, locals.adminBase || '/admin');
	const rt = getRuntime();
	if (!rt.config.admin.allow_setup || rt.users.count() > 0) {
		redirect(303, `${locals.adminBase}/login`);
	}
	return {};
};
