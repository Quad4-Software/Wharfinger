<script lang="ts">
	import { CircleAlert, CircleCheck } from '@lucide/svelte';
	import { relativeTime } from '$lib/utils/format';
	import { describeAction, iconForAction } from '$lib/utils/audit-kind';

	export interface ActivityItem {
		action: string;
		username: string | null;
		detail?: string | null;
		ip?: string | null;
		at: number;
	}

	const { items, limit = 10 }: { items: ActivityItem[]; limit?: number } = $props();
</script>

<ul class="space-y-1">
	{#each items.slice(0, limit) as a (`${a.at}-${a.action}-${a.username ?? ''}`)}
		{@const d = describeAction(a.action)}
		{@const Icon = iconForAction(a.action)}
		<li class="flex items-start gap-2.5 py-1.5">
			<span
				class="mt-0.5 shrink-0 {d.kind === 'bad'
					? 'text-down'
					: d.kind === 'warn'
						? 'text-degraded'
						: d.kind === 'ok'
							? 'text-up'
							: d.kind === 'accent'
								? 'text-accent'
								: 'text-faint'}"
			>
				<Icon class="size-4" />
			</span>
			<div class="min-w-0 flex-1">
				<p class="text-sm leading-tight {d.kind === 'bad' ? 'text-down-fg' : 'text-fg'}">
					{d.label}
				</p>
				<p class="truncate text-xs text-faint">
					{a.username ?? 'anonymous'}{a.ip ? ` · ${a.ip}` : ''}{a.detail ? ` · ${a.detail}` : ''}
				</p>
			</div>
			<span class="shrink-0 pt-0.5 text-xs text-faint">{relativeTime(a.at)}</span>
		</li>
	{/each}
</ul>
{#if items.length === 0}
	<p class="flex items-center gap-2 py-2 text-sm text-faint">
		<CircleCheck class="size-4" /> No activity yet
	</p>
{:else if items.some((a) => a.action.endsWith('.fail') || a.action.endsWith('.denied'))}
	<p class="mt-2 flex items-center gap-1.5 text-xs text-degraded-fg">
		<CircleAlert class="size-3.5" /> Failed actions are highlighted above
	</p>
{/if}
