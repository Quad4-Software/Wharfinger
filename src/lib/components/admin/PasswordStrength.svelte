<script lang="ts">
	import { passwordStrength } from '$lib/shared/password';

	const {
		password,
		username = '',
		minLength = 12
	}: { password: string; username?: string; minLength?: number } = $props();

	const s = $derived(passwordStrength(password, { username, minLength }));

	const TONES = ['bg-down', 'bg-down', 'bg-maint', 'bg-up', 'bg-up'] as const;
</script>

{#if password.length > 0}
	<div class="mt-1.5 space-y-1" aria-live="polite">
		<div class="flex items-center gap-2">
			<div
				class="flex flex-1 gap-1"
				role="meter"
				aria-label="Password strength"
				aria-valuemin={0}
				aria-valuemax={4}
				aria-valuenow={s.score}
				aria-valuetext={s.label}
			>
				{#each [0, 1, 2, 3] as i (i)}
					<div
						class="h-1 flex-1 rounded-full transition-colors duration-200 {i < s.score
							? TONES[s.score]
							: 'bg-edge'}"
					></div>
				{/each}
			</div>
			<span class="text-[11px] text-faint">{s.label}</span>
		</div>
		{#if s.rejected}
			<p class="text-[11px] text-down-fg">{s.rejected}</p>
		{:else if s.hints.length > 0}
			<p class="text-[11px] text-faint">{s.hints.join(' · ')}</p>
		{/if}
	</div>
{/if}
