<script lang="ts">
	import { TriangleAlert, Flame, CircleCheck, ChevronRight, EyeOff } from '@lucide/svelte';
	import type { Incident } from '$lib/shared/types';
	import { fmtDateTime, t } from '$lib/i18n/locale.svelte';
	import { durationBetween } from '$lib/utils/format';
	import { onMount } from 'svelte';

	const {
		incidents,
		title,
		collapsible = false,
		persistKey = '',
		onclear,
		cleared = 0,
		onrestore
	}: {
		incidents: Incident[];
		title: string;
		/** Show a chevron that collapses the list to its header row. */
		collapsible?: boolean;
		/** localStorage key remembering the collapsed state. */
		persistKey?: string;
		/** When set, a control dismisses the listed incidents for this visitor. */
		onclear?: () => void;
		/** Count of dismissed incidents, with a restore affordance. */
		cleared?: number;
		onrestore?: () => void;
	} = $props();

	let collapsed = $state(false);

	onMount(() => {
		if (!persistKey) return;
		try {
			collapsed = localStorage.getItem(persistKey) === '1';
		} catch {
			// storage unavailable, collapse stays session-local
		}
	});

	function toggle(): void {
		collapsed = !collapsed;
		if (persistKey) {
			try {
				localStorage.setItem(persistKey, collapsed ? '1' : '0');
			} catch {
				// storage unavailable
			}
		}
	}

	const sevIcon = { minor: TriangleAlert, major: Flame, maintenance: TriangleAlert } as const;
	const sevClass = {
		minor: 'text-degraded-fg bg-degraded/10 ring-degraded/30',
		major: 'text-down-fg bg-down/10 ring-down/30',
		maintenance: 'text-maint-fg bg-maint/10 ring-maint/30'
	} as const;
</script>

<section class="space-y-3" aria-label={title}>
	<div class="flex items-center gap-2">
		{#if collapsible}
			<button
				type="button"
				class="flex items-center gap-1.5 text-xs font-semibold tracking-widest text-muted uppercase transition-colors hover:text-fg"
				aria-expanded={!collapsed}
				aria-label={collapsed ? t('incident.expand') : t('incident.collapse')}
				onclick={toggle}
			>
				<ChevronRight class="size-3.5 transition-transform {collapsed ? '' : 'rotate-90'}" />
				{title}
			</button>
		{:else}
			<h2 class="text-xs font-semibold tracking-widest text-muted uppercase">{title}</h2>
		{/if}
		{#if collapsed && incidents.length > 0}
			<span class="chip chip-muted">{incidents.length}</span>
		{/if}
		<span class="ml-auto flex items-center gap-1.5">
			{#if cleared > 0 && onrestore}
				<button type="button" class="chip chip-muted cursor-pointer" onclick={onrestore}>
					<EyeOff class="size-3" />
					{t('incident.hidden', { count: cleared })} · {t('incident.show')}
				</button>
			{/if}
			{#if onclear && incidents.length > 0}
				<button
					type="button"
					class="chip cursor-pointer transition-colors hover:border-faint"
					onclick={onclear}
					title={t('incident.hide')}
				>
					{t('common.clear')}
				</button>
			{/if}
		</span>
	</div>
	{#if !collapsed}
		{#if incidents.length === 0 && cleared === 0}
			<div class="card flex items-center gap-3 p-4 text-sm text-muted">
				<CircleCheck class="size-4 text-up" />
				{t('incident.none')}
			</div>
		{:else}
			<div class="space-y-3">
				{#each incidents as inc (inc.id)}
					{@const Icon = sevIcon[inc.severity]}
					<article class="card p-4">
						<div class="flex flex-wrap items-start justify-between gap-2">
							<div class="flex items-start gap-3">
								<span
									class="mt-0.5 inline-flex size-7 items-center justify-center rounded-lg ring-1 ring-inset {sevClass[
										inc.severity
									]}"
								>
									<Icon class="size-4" />
								</span>
								<div>
									<h3 class="text-sm font-medium text-fg">{inc.title}</h3>
									<p class="mt-0.5 text-xs text-muted">
										{fmtDateTime(inc.startedAt)} ·
										{inc.resolvedAt
											? t('incident.resolved_after', {
													duration: durationBetween(inc.startedAt, inc.resolvedAt)
												})
											: t('incident.ongoing')} · {t('incident.affects', {
											services: inc.services.join(', ')
										})}
									</p>
								</div>
							</div>
							<span
								class="rounded-full px-2 py-0.5 text-[11px] font-medium {inc.resolvedAt
									? 'bg-up/10 text-up-fg'
									: 'bg-down/10 text-down-fg'}"
							>
								{inc.resolvedAt ? t('incident.state_resolved') : t('incident.state_ongoing')}
							</span>
						</div>
						{#if inc.updates.length > 0}
							<ul class="mt-3 space-y-1.5 border-l border-edge pl-4">
								{#each inc.updates as u (u.at)}
									<li class="text-xs text-muted">
										<span class="text-faint">{fmtDateTime(u.at)}</span> · {u.message}
									</li>
								{/each}
							</ul>
						{/if}
					</article>
				{/each}
			</div>
		{/if}
	{/if}
</section>
