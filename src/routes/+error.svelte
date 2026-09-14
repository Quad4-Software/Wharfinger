<script lang="ts">
	import { page } from '$app/state';
	import ErrorPage from '$lib/components/ErrorPage.svelte';

	// Under the admin mount the natural "home" is the panel dashboard,
	// not the public status page.
	const adminBase = $derived(page.data.adminBase as string | undefined);
	const underAdmin = $derived(
		adminBase !== undefined &&
			(page.url.pathname === adminBase || page.url.pathname.startsWith(`${adminBase}/`))
	);
</script>

<svelte:head>
	<title>{page.status} {page.error?.message ?? 'Error'}</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<ErrorPage
	status={page.status}
	message={page.error?.message ?? 'Something went wrong'}
	errorId={page.error?.errorId ?? null}
	homeHref={underAdmin ? adminBase : '/'}
	homeLabel={underAdmin ? 'Back to panel' : 'Back to status'}
/>
