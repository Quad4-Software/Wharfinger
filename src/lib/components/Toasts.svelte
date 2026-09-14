<script lang="ts">
	import { fly } from 'svelte/transition';
	import { CircleCheck, TriangleAlert, Info, X } from '@lucide/svelte';
	import { toasts, dismiss, pause, resume } from '$lib/state/toasts.svelte';

	const ICONS = {
		success: CircleCheck,
		error: TriangleAlert,
		info: Info
	};
	const ICON_CLASS = {
		success: 'text-up-fg',
		error: 'text-down-fg',
		info: 'text-maint-fg'
	};
	const BAR_CLASS = {
		success: 'bg-up',
		error: 'bg-down',
		info: 'bg-maint'
	};
</script>

<div
	class="pointer-events-none fixed inset-x-3 bottom-3 z-[100] flex flex-col items-stretch gap-2 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-96"
>
	{#each toasts() as t (t.id)}
		{@const Icon = ICONS[t.kind]}
		{#key t.key}
			<div
				transition:fly={{ y: 14, duration: 220 }}
				class="card toast group pointer-events-auto relative overflow-hidden px-3.5 pt-3 pb-3.5 shadow-xl"
				role={t.kind === 'error' ? 'alert' : 'status'}
				onpointerenter={() => {
					pause(t.id);
				}}
				onpointerleave={() => {
					resume(t.id);
				}}
			>
				<div class="flex items-start gap-2.5">
					<Icon class="mt-0.5 size-4 shrink-0 {ICON_CLASS[t.kind]}" />
					<p class="flex-1 text-sm leading-snug text-fg">{t.text}</p>
					<button
						class="text-faint transition-colors hover:text-fg"
						onclick={() => {
							dismiss(t.id);
						}}
						aria-label="Dismiss"
					>
						<X class="size-4" />
					</button>
				</div>
				<div
					class="absolute inset-x-0 bottom-0 h-0.5 origin-left opacity-50 group-hover:[animation-play-state:paused] {BAR_CLASS[
						t.kind
					]}"
					style="animation: toast-progress {t.ttl}ms linear forwards"
				></div>
			</div>
		{/key}
	{/each}
</div>
