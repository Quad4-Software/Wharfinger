import { page } from '$app/state';

// Client helpers for the admin panel. The external mount path comes
// from layout data because admin.base_path is configurable.

function adminBase(): string {
	return (page.data.adminBase as string | undefined) ?? '/admin';
}

export function adminHref(sub = ''): string {
	return `${adminBase()}${sub}`;
}

/**
 * Post-login redirect target. Only paths under the admin mount are
 * allowed; anything else (external URLs, protocol-relative //host,
 * paths outside the panel) falls back to the dashboard.
 */
export function safeNext(next: string | null): string {
	const base = adminBase();
	if (next) {
		const path = next.split(/[?#]/)[0];
		if (path === base || path.startsWith(`${base}/`)) return next;
	}
	return adminHref('/');
}

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly data: Record<string, unknown> = {}
	) {
		super(message);
	}
}

/** Human-readable message from a failed api() call, including schema issues. */
export function errMessage(err: unknown, fallback = 'request failed'): string {
	if (err instanceof ApiError) {
		const issues = err.data.issues;
		if (typeof issues === 'string') return `invalid config: ${issues}`;
		return err.message;
	}
	return err instanceof Error ? err.message : fallback;
}

export async function api<T = Record<string, unknown>>(
	sub: string,
	opts: { method?: string; body?: unknown; rawBody?: BodyInit } = {}
): Promise<T> {
	const res = await fetch(`${adminBase()}/api${sub}`, {
		method: opts.method ?? (opts.body === undefined && opts.rawBody === undefined ? 'GET' : 'POST'),
		headers: opts.body === undefined ? {} : { 'content-type': 'application/json' },
		body: opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body))
	});
	if (res.status === 401) {
		const next = encodeURIComponent(location.pathname + location.search);
		location.href = `${adminBase()}/login?next=${next}`;
		throw new ApiError('authentication required', 401);
	}
	const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	if (!res.ok) {
		throw new ApiError(
			typeof data.error === 'string' ? data.error : `request failed (${res.status})`,
			res.status,
			data
		);
	}
	return data as T;
}
