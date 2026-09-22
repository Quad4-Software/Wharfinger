<script lang="ts">
	import { page } from '$app/state';
	import ErrorPage from '$lib/components/ErrorPage.svelte';
	import { t } from '$lib/i18n/locale.svelte';

	// Under the admin mount the natural "home" is the panel dashboard,
	// not the public status page.
	const adminBase = $derived(page.data.adminBase as string | undefined);
	const underAdmin = $derived(
		adminBase !== undefined &&
			(page.url.pathname === adminBase || page.url.pathname.startsWith(`${adminBase}/`))
	);
</script>

<svelte:head>
	<title>{page.status} {page.error?.message ?? t('error.title')}</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<ErrorPage
	status={page.status}
	message={page.error?.message ?? t('error.went_wrong')}
	errorId={page.error?.errorId ?? null}
	homeHref={underAdmin ? adminBase : '/'}
	homeLabel={underAdmin ? t('error.back_panel') : t('error.back_status')}
/>
