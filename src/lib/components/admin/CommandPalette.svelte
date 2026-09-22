<script lang="ts">
	import { tick } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		Search,
		Activity,
		Files,
		Siren,
		Wrench,
		Server,
		Users,
		MessageSquare,
		Bug,
		ScrollText,
		LogOut,
		ExternalLink,
		ArrowRight,
		LoaderCircle
	} from '@lucide/svelte';
	import { adminHref, api } from '$lib/state/admin.svelte';
	import { NAV_SECTIONS, type NavItem } from '$lib/components/admin/nav';

	interface Hit {
		kind: string;
		id: string;
		title: string;
		sub: string;
		href: string;
	}

	interface Entry {
		key: string;
		group: string;
		icon: typeof Activity;
		title: string;
		sub: string;
		href: string | null;
		action?: () => void | Promise<void>;
	}

	let { open = $bindable(false), perms }: { open?: boolean; perms: string[] } = $props();

	let query = $state('');
	let hits = $state<Hit[]>([]);
	let loading = $state(false);
	let sel = $state(0);
	let inputEl = $state<HTMLInputElement | null>(null);
	let debounce: ReturnType<typeof setTimeout> | null = null;
	let fetchSeq = 0;

	const KIND_ICON: Record<string, typeof Activity> = {
		service: Activity,
		page: Files,
		incident: Siren,
		maintenance: Wrench,
		agent: Server,
		user: Users,
		room: MessageSquare,
		issue: Bug,
		audit: ScrollText
	};
	const KIND_LABEL: Record<string, string> = {
		service: 'Services',
		page: 'Pages',
		incident: 'Incidents',
		maintenance: 'Maintenance',
		agent: 'Systems',
		user: 'Users',
		room: 'Chat rooms',
		issue: 'Error tracking',
		audit: 'Audit log'
	};

	// Subsequence match: every query char appears in order. Prefix and
	// substring hits rank above scattered matches.
	function matchScore(text: string, q: string): number {
		const t = text.toLowerCase();
		if (!q) return 1;
		if (t.startsWith(q)) return 3;
		if (t.includes(q)) return 2;
		let i = 0;
		for (const c of t) if (c === q[i]) i++;
		return i === q.length ? 1 : 0;
	}

	const navEntries = $derived.by((): Entry[] => {
		const q = query.trim().toLowerCase();
		const items: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items).filter(
			(n) => !n.perm || perms.includes(n.perm)
		);
		const out: Entry[] = [];
		for (const n of items) {
			const score = Math.max(matchScore(n.label, q), matchScore(`go to ${n.label}`, q) - 0.5);
			if (q && score <= 0) continue;
			out.push({
				key: `nav:${n.sub}`,
				group: 'Go to',
				icon: n.icon,
				title: n.label,
				sub: n.sub || '/',
				href: adminHref(n.sub || '/')
			});
		}
		out.push({
			key: 'nav:public',
			group: 'Go to',
			icon: ExternalLink,
			title: 'Public status page',
			sub: 'open in this tab',
			href: '/'
		});
		if (!q || matchScore('sign out', query.trim().toLowerCase()) > 0) {
			out.push({
				key: 'act:logout',
				group: 'Actions',
				icon: LogOut,
				title: 'Sign out',
				sub: 'end this session',
				href: null,
				action: async () => {
					await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
					location.href = adminHref('/login');
				}
			});
		}
		return out;
	});

	const remoteEntries = $derived.by((): Entry[] => {
		const q = query.trim().toLowerCase();
		return hits
			.map((h): Entry & { score: number } => {
				const score = matchScore(h.title, q) * 2 + matchScore(h.sub, q) + matchScore(h.id, q) * 0.5;
				return {
					key: `${h.kind}:${h.id}`,
					group: KIND_LABEL[h.kind] ?? 'Results',
					icon: KIND_ICON[h.kind] ?? Search,
					title: h.title,
					sub: h.sub,
					href: h.href.startsWith('/') ? adminHref(h.href) : h.href,
					score
				};
			})
			.filter((e) => e.score > 0)
			.sort((a, b) => b.score - a.score);
	});

	const flat = $derived([...navEntries, ...remoteEntries]);
	const selEntry = $derived<Entry | null>(
		flat.length === 0 ? null : flat[Math.min(sel, flat.length - 1)]
	);

	function close(): void {
		open = false;
		query = '';
		hits = [];
		sel = 0;
		if (debounce) clearTimeout(debounce);
	}

	async function run(e: Entry | null): Promise<void> {
		if (!e) return;
		close();
		if (e.action) {
			await e.action();
			return;
		}
		if (e.href) await goto(e.href);
	}

	function onKey(e: KeyboardEvent): void {
		if (e.key === 'Escape') {
			e.stopPropagation();
			close();
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			sel = Math.min(sel + 1, flat.length - 1);
			scrollSel();
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			sel = Math.max(sel - 1, 0);
			scrollSel();
		} else if (e.key === 'Enter') {
			e.preventDefault();
			void run(selEntry);
		}
	}

	function scrollSel(): void {
		void tick().then(() => {
			document
				.getElementById('palette-list')
				?.querySelector(`[data-idx="${Math.min(sel, flat.length - 1)}"]`)
				?.scrollIntoView({ block: 'nearest' });
		});
	}

	function onInput(): void {
		sel = 0;
		if (debounce) clearTimeout(debounce);
		const q = query.trim();
		if (q.length < 2) {
			hits = [];
			loading = false;
			return;
		}
		loading = true;
		debounce = setTimeout(() => {
			const seq = ++fetchSeq;
			void api<{ results: Hit[] }>(`/search?q=${encodeURIComponent(q)}`)
				.then((r) => {
					if (seq === fetchSeq) hits = r.results;
				})
				.catch(() => {
					if (seq === fetchSeq) hits = [];
				})
				.finally(() => {
					if (seq === fetchSeq) loading = false;
				});
		}, 180);
	}

	$effect(() => {
		if (open) {
			void tick().then(() => inputEl?.focus());
		}
	});

	// Bucket by group label so remote hits of one kind share a header
	// even when scores interleave them.
	const groups = $derived.by((): { label: string; entries: { e: Entry; i: number }[] }[] => {
		const out: { label: string; entries: { e: Entry; i: number }[] }[] = [];
		flat.forEach((e, i) => {
			const g = out.find((x) => x.label === e.group);
			if (g) g.entries.push({ e, i });
			else out.push({ label: e.group, entries: [{ e, i }] });
		});
		return out;
	});
</script>

<svelte:window
	onkeydown={(e: KeyboardEvent) => {
		if (open && e.key === 'Escape') close();
	}}
/>

{#if open}
	<div
		class="fixed inset-0 z-[60] bg-black/55 backdrop-blur-[2px]"
		role="presentation"
		onclick={close}
	></div>
	<div
		class="fixed inset-x-3 top-[12dvh] z-[61] mx-auto max-w-xl overflow-hidden rounded-xl border border-edge bg-raised shadow-2xl md:top-[16dvh]"
		role="dialog"
		aria-modal="true"
		aria-label="Command palette"
	>
		<div class="flex items-center gap-2.5 border-b border-edge px-4">
			<Search class="size-4 shrink-0 text-faint" />
			<input
				bind:this={inputEl}
				class="min-w-0 flex-1 bg-transparent py-3.5 text-sm text-fg outline-none placeholder:text-faint"
				placeholder="Search pages, services, incidents, people..."
				bind:value={query}
				oninput={onInput}
				onkeydown={onKey}
				role="combobox"
				aria-expanded="true"
				aria-controls="palette-list"
				aria-activedescendant={selEntry ? `pal-${selEntry.key}` : undefined}
				aria-label="Search"
			/>
			{#if loading}
				<LoaderCircle class="size-4 shrink-0 animate-spin text-faint" />
			{/if}
			<kbd
				class="rounded border border-edge bg-panel px-1.5 py-0.5 font-sans text-[10px] text-faint"
				>esc</kbd
			>
		</div>
		<div id="palette-list" class="thin-scroll max-h-[55dvh] overflow-y-auto p-1.5" role="listbox">
			{#if flat.length === 0}
				<p class="px-3 py-8 text-center text-sm text-faint">
					{query.trim().length >= 2 ? 'No matches.' : 'Type to search.'}
				</p>
			{:else}
				{#each groups as g (g.label)}
					<p class="px-3 pt-2.5 pb-1 text-[10px] font-semibold tracking-wider text-faint uppercase">
						{g.label}
					</p>
					{#each g.entries as { e, i } (e.key)}
						{@const Icon = e.icon}
						<button
							id="pal-{e.key}"
							data-idx={i}
							role="option"
							aria-selected={i === sel}
							class="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors {i ===
							sel
								? 'bg-panel text-fg'
								: 'text-muted hover:bg-panel/60'}"
							onmouseenter={() => (sel = i)}
							onclick={() => void run(e)}
						>
							<Icon class="size-4 shrink-0 {i === sel ? 'text-accent' : 'text-faint'}" />
							<span class="min-w-0 flex-1">
								<span class="block truncate text-sm">{e.title}</span>
								{#if e.sub}<span class="block truncate text-xs text-faint">{e.sub}</span>{/if}
							</span>
							{#if i === sel}<ArrowRight class="size-3.5 shrink-0 text-faint" />{/if}
						</button>
					{/each}
				{/each}
			{/if}
		</div>
		<div class="flex items-center gap-4 border-t border-edge px-4 py-2 text-[10px] text-faint">
			<span>arrows navigate</span>
			<span>enter opens</span>
			<span>esc closes</span>
			<span class="ml-auto">Ctrl K toggles</span>
		</div>
	</div>
{/if}
