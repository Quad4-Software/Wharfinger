<script lang="ts">
	import { Collapsible } from 'bits-ui';
	import { ChevronDown, ShieldCheck, ShieldAlert } from '@lucide/svelte';
	import type { ServiceSnapshot } from '$lib/shared/types';
	import { fmtMs, fmtPct, relativeTime } from '$lib/utils/format';
	import StatusPill from './StatusPill.svelte';
	import UptimeBars from './UptimeBars.svelte';
	import LatencyPanel from './LatencyPanel.svelte';

	const { service, now }: { service: ServiceSnapshot; now: number } = $props();

	let open = $state(false);

	const initial = $derived(service.name.trim().charAt(0).toUpperCase() || '?');
	const stats = $derived([
		{ label: '24 hours', value: service.uptime.d24 },
		{ label: '7 days', value: service.uptime.d7 },
		{ label: '30 days', value: service.uptime.d30 },
		{ label: '90 days', value: service.uptime.d90 }
	]);
</script>

<Collapsible.Root bind:open>
	<div class="card @container overflow-hidden">
		<Collapsible.Trigger
			class="group flex w-full flex-col gap-3 px-4 py-4 text-left transition-colors hover:bg-overlay/2 @sm:px-5"
		>
			<div class="flex flex-wrap items-center justify-between gap-3">
				<div class="flex min-w-0 items-center gap-3">
					{#if service.icon}
						<img
							src={service.icon}
							alt=""
							width="20"
							height="20"
							loading="lazy"
							decoding="async"
							class="size-5 shrink-0 rounded-[4px] bg-overlay/10 object-contain"
						/>
					{:else}
						<span
							class="flex size-5 shrink-0 items-center justify-center rounded-[4px] bg-overlay/8 text-[11px] font-semibold text-fg"
							aria-hidden="true">{initial}</span
						>
					{/if}
					<div class="min-w-0">
						<div class="flex items-center gap-2.5">
							<h3 class="truncate text-[15px] font-medium text-fg">{service.name}</h3>
							<StatusPill status={service.status} />
						</div>
						{#if service.description}
							<p class="mt-0.5 truncate text-xs text-muted">{service.description}</p>
						{/if}
					</div>
				</div>
				<div class="flex shrink-0 items-center gap-4">
					<div class="hidden text-right @sm:block">
						<div class="font-mono text-sm tabular-nums text-fg">
							{fmtPct(service.uptime.d90)}
						</div>
						<div class="text-[11px] text-muted">90d uptime</div>
					</div>
					<div class="hidden text-right @sm:block">
						<div class="font-mono text-sm tabular-nums text-fg">
							{fmtMs(service.latencyMs)}
						</div>
						<div class="text-[11px] text-muted">latency</div>
					</div>
					<ChevronDown
						class="size-4 text-muted transition-transform duration-200 group-data-[state=open]:rotate-180"
					/>
				</div>
			</div>
			<UptimeBars days={service.days} />
			<div class="flex justify-between text-[10px] tracking-wide text-faint">
				<span>{service.days.length} days ago</span>
				<span>today</span>
			</div>
		</Collapsible.Trigger>

		<Collapsible.Content
			class="overflow-hidden border-t border-edge data-[state=open]:animate-fade-in"
		>
			<div class="grid gap-6 px-4 py-5 @sm:grid-cols-[1fr_220px] @sm:px-5">
				<LatencyPanel {service} />
				<div class="space-y-3">
					<div class="grid grid-cols-2 gap-2 @sm:grid-cols-1">
						{#each stats as s (s.label)}
							<div class="flex items-baseline justify-between rounded-lg bg-overlay/3 px-3 py-2">
								<span class="text-xs text-muted">{s.label}</span>
								<span class="font-mono text-sm tabular-nums text-fg">{fmtPct(s.value)}</span>
							</div>
						{/each}
					</div>
					{#if service.slo}
						{@const slo = service.slo}
						<div class="rounded-lg bg-overlay/3 px-3 py-2">
							<div class="flex items-baseline justify-between">
								<span class="text-xs text-muted">SLO {slo.target}%</span>
								<span
									class="font-mono text-sm {slo.budgetRemaining !== null &&
									slo.budgetRemaining < 0.25
										? 'text-down'
										: 'text-fg'}"
								>
									{slo.budgetRemaining === null
										? '--'
										: `${Math.round(slo.budgetRemaining * 100)}%`}
								</span>
							</div>
							<div class="mt-1 h-1 overflow-hidden rounded-full bg-overlay/10">
								<div
									class="h-full rounded-full {slo.budgetRemaining !== null &&
									slo.budgetRemaining < 0.25
										? 'bg-down'
										: 'bg-up'}"
									style="width: {Math.round((slo.budgetRemaining ?? 1) * 100)}%"
								></div>
							</div>
							<p class="mt-1 text-[10px] text-faint">
								error budget left, {slo.windowDays}d window{slo.burnRate !== null &&
								slo.burnRate > 1
									? ` · burning ${slo.burnRate.toFixed(1)}x`
									: ''}
							</p>
						</div>
					{/if}
					{#if service.certDays !== null}
						<div
							class="flex items-center gap-2 rounded-lg px-3 py-2 {service.certWarn
								? 'bg-degraded/10 text-degraded-fg ring-1 ring-degraded/30'
								: 'bg-overlay/3 text-muted'}"
						>
							{#if service.certWarn}
								<ShieldAlert class="size-4 shrink-0" />
							{:else}
								<ShieldCheck class="size-4 shrink-0 text-up" />
							{/if}
							<span class="text-xs">
								TLS certificate expires in {service.certDays} day{service.certDays === 1 ? '' : 's'}
							</span>
						</div>
					{/if}
					{#if service.lastCheckedAt}
						<p class="text-[11px] text-faint">
							Last checked {relativeTime(service.lastCheckedAt, now)}{service.lastDetail
								? ` · ${service.lastDetail}`
								: ''}
						</p>
					{/if}
				</div>
			</div>
		</Collapsible.Content>
	</div>
</Collapsible.Root>
