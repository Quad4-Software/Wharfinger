import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getRuntime } from '$lib/server/runtime';

export const load: PageServerLoad = ({ locals }) => {
	if (locals.user) redirect(303, locals.adminBase || '/admin');
	const rt = getRuntime();
	// No accounts yet: send visitors straight to first-run setup.
	if (rt.config.admin.allow_setup && rt.users.count() === 0) {
		redirect(303, `${locals.adminBase}/setup`);
	}
	const oidc = rt.config.oidc;
	return {
		setupNeeded: false,
		sso: oidc.enabled && oidc.client_id ? { label: oidc.button_label } : null
	};
};
