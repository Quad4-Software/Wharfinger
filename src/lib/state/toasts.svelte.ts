import { SvelteMap } from 'svelte/reactivity';

export interface Toast {
	id: number;
	kind: 'success' | 'error' | 'info';
	text: string;
	ttl: number;
	/** Bumped on dedupe so the UI can restart the countdown animation. */
	key: number;
}

interface Timer {
	remaining: number;
	startedAt: number;
	/** Null while paused (pointer hovering). */
	handle: ReturnType<typeof setTimeout> | null;
}

let nextId = 1;
const items = $state<Toast[]>([]);
const timers = new SvelteMap<number, Timer>();

export function toasts(): Toast[] {
	return items;
}

function arm(id: number, t: Timer): void {
	t.startedAt = Date.now();
	t.handle = setTimeout(() => {
		dismiss(id);
	}, t.remaining);
}

export function toast(kind: Toast['kind'], text: string, ttlMs = 4500): void {
	// Identical toasts refresh in place instead of stacking duplicates.
	const existing = items.find((t) => t.kind === kind && t.text === text);
	if (existing) {
		existing.ttl = ttlMs;
		existing.key += 1;
		const t = timers.get(existing.id);
		if (t) {
			if (t.handle) clearTimeout(t.handle);
			t.remaining = ttlMs;
			if (t.handle) arm(existing.id, t);
		}
		return;
	}
	const id = nextId++;
	items.push({ id, kind, text, ttl: ttlMs, key: 0 });
	const t: Timer = { remaining: ttlMs, startedAt: Date.now(), handle: null };
	timers.set(id, t);
	arm(id, t);
}

export function dismiss(id: number): void {
	const i = items.findIndex((t) => t.id === id);
	if (i !== -1) items.splice(i, 1);
	const t = timers.get(id);
	if (t) {
		if (t.handle) clearTimeout(t.handle);
		timers.delete(id);
	}
}

// Hover pause: the countdown freezes while the pointer is over a toast.
export function pause(id: number): void {
	const t = timers.get(id);
	if (!t?.handle) return;
	clearTimeout(t.handle);
	t.handle = null;
	t.remaining -= Date.now() - t.startedAt;
}

export function resume(id: number): void {
	const t = timers.get(id);
	if (!t || t.handle) return;
	arm(id, t);
}
