import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServiceConfig } from '$lib/server/config/schema';
import { blockedHost, type Egress, type FetchInit } from '$lib/server/http/egress';
import {
	ICON_FETCH_TIMEOUT_MS,
	ICON_HTML_MAX_BYTES,
	ICON_MAX_BYTES,
	ICON_TTL_MS
} from '$lib/server/constants';

// Fetches and caches each service's favicon so cards can show a brand
// mark without the visitor's browser ever talking to the origin. Icons
// are stored under <data>/icons as <id>.bin + <id>.json metadata and
// re-fetched every TTL. Everything is treated as hostile: content type
// is allowlisted, size is capped, and the route serves SVG under a
// script-blocking CSP.

const ALLOWED_TYPES = new Set([
	'image/png',
	'image/jpeg',
	'image/gif',
	'image/webp',
	'image/avif',
	'image/x-icon',
	'image/vnd.microsoft.icon',
	'image/svg+xml'
]);

const EXT_TYPES: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	avif: 'image/avif',
	ico: 'image/x-icon',
	svg: 'image/svg+xml'
};

export interface CachedIcon {
	data: Buffer;
	contentType: string;
}

interface IconMeta {
	contentType: string;
	fetchedAt: number;
	source: string;
}

export class IconCache {
	private refreshing = new Set<string>();
	private timer: NodeJS.Timeout | null = null;

	constructor(
		private readonly dir: string,
		private readonly userAgent: string,
		private readonly egress: Egress
	) {
		mkdirSync(dir, { recursive: true });
	}

	/** Cached icon bytes, or null when never fetched. */
	get(serviceId: string): CachedIcon | null {
		const meta = this.meta(serviceId);
		if (!meta) return null;
		try {
			return { data: readFileSync(this.binPath(serviceId)), contentType: meta.contentType };
		} catch {
			return null;
		}
	}

	has(serviceId: string): boolean {
		return this.meta(serviceId) !== null && existsSync(this.binPath(serviceId));
	}

	/** Refresh all icons now, then every TTL. Safe to call repeatedly. */
	schedule(services: ServiceConfig[]): void {
		if (this.timer) clearInterval(this.timer);
		void this.refreshAll(services);
		this.timer = setInterval(() => {
			void this.refreshAll(services);
		}, ICON_TTL_MS);
		this.timer.unref();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	private async refreshAll(services: ServiceConfig[]): Promise<void> {
		for (const s of services) {
			if (this.refreshing.has(s.id)) continue;
			this.refreshing.add(s.id);
			try {
				await this.fetchIcon(s);
			} catch {
				// Icon fetching is best effort; stale cache or fallback wins.
			} finally {
				this.refreshing.delete(s.id);
			}
		}
	}

	private async fetchIcon(s: ServiceConfig): Promise<void> {
		const meta = this.meta(s.id);
		if (meta && Date.now() - meta.fetchedAt < ICON_TTL_MS) return;

		const base = iconBaseUrl(s);
		const candidates: string[] = [`${base}/favicon.ico`];

		const html = await this.fetchText(`${base}/`);
		if (html) {
			for (const href of findIconHrefs(html, `${base}/`)) {
				candidates.unshift(href); // <link> icons beat the default
			}
		}

		for (const url of [...new Set(candidates)].slice(0, 4)) {
			const icon = await this.fetchBinary(url);
			if (!icon) continue;
			writeFileSync(this.binPath(s.id), icon.data);
			writeFileSync(
				this.metaPath(s.id),
				JSON.stringify({
					contentType: icon.contentType,
					fetchedAt: Date.now(),
					source: url
				} satisfies IconMeta)
			);
			return;
		}
	}

	// Every fetch goes through the shared egress dispatcher so DNS is
	// re-validated at connect time on every redirect hop; the precheck
	// refuses link-local and metadata targets before a connection is
	// even attempted. A monitored origin can put any URL in a link tag,
	// so unguarded fetches here would be a blind SSRF whose response is
	// republished at /favicon/<id>.
	private blocked(url: string): boolean {
		if (this.egress.allowLinkLocal()) return false;
		try {
			return blockedHost(new URL(url).hostname);
		} catch {
			return true;
		}
	}

	private async fetchText(url: string): Promise<string | null> {
		try {
			if (this.blocked(url)) return null;
			const res = await fetch(url, {
				signal: AbortSignal.timeout(ICON_FETCH_TIMEOUT_MS),
				redirect: 'follow',
				headers: { 'user-agent': this.userAgent, accept: 'text/html' },
				dispatcher: this.egress.dispatcher
			} as FetchInit);
			if (!res.ok || !(res.headers.get('content-type') ?? '').includes('html')) return null;
			const buf = new Uint8Array(await res.arrayBuffer());
			return new TextDecoder().decode(buf.subarray(0, ICON_HTML_MAX_BYTES));
		} catch {
			return null;
		}
	}

	private async fetchBinary(url: string): Promise<CachedIcon | null> {
		try {
			if (!isHttpUrl(url) || this.blocked(url)) return null;
			const res = await fetch(url, {
				signal: AbortSignal.timeout(ICON_FETCH_TIMEOUT_MS),
				redirect: 'follow',
				headers: { 'user-agent': this.userAgent, accept: 'image/*' },
				dispatcher: this.egress.dispatcher
			} as FetchInit);
			if (!res.ok) return null;
			const raw = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
			const contentType = ALLOWED_TYPES.has(raw) ? raw : typeFromExtension(url);
			if (!contentType) return null;
			const buf = Buffer.from(await res.arrayBuffer());
			if (buf.byteLength === 0 || buf.byteLength > ICON_MAX_BYTES) return null;
			// SVG is the one format that can carry scripts; only accept it when
			// the payload actually looks like an SVG document.
			if (contentType === 'image/svg+xml' && !buf.subarray(0, 2048).toString().includes('<svg')) {
				return null;
			}
			return { data: buf, contentType };
		} catch {
			return null;
		}
	}

	private meta(serviceId: string): IconMeta | null {
		try {
			return JSON.parse(readFileSync(this.metaPath(serviceId), 'utf8')) as IconMeta;
		} catch {
			return null;
		}
	}

	private binPath(id: string): string {
		return join(this.dir, `${id}.bin`);
	}

	private metaPath(id: string): string {
		return join(this.dir, `${id}.json`);
	}
}

/** Public https origin used as the icon search base for a service. */
function iconBaseUrl(s: ServiceConfig): string {
	if (s.type === 'http' || s.type === 'json') return new URL(s.url).origin;
	// Push services have no remote target; nothing to icon.
	if (s.type === 'push') return '';
	if (s.type === 'websocket') {
		const u = new URL(s.url);
		return `${u.protocol === 'wss:' ? 'https' : 'http'}://${u.host}`;
	}
	if (s.type === 'rdap' || s.type === 'domain') return `https://${s.domain}`;
	return `https://${s.host}`;
}

function isHttpUrl(url: string): boolean {
	try {
		const u = new URL(url);
		return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password;
	} catch {
		return false;
	}
}

function typeFromExtension(url: string): string | null {
	try {
		const ext = new URL(url).pathname.split('.').pop()?.toLowerCase() ?? '';
		return EXT_TYPES[ext] ?? null;
	} catch {
		return null;
	}
}

// Quoted attribute values may legitimately contain '>' so the tag
// pattern must not stop at the first one.
const LINK_TAG = /<link\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const ATTR = /(?<name>[a-zA-Z-]+)\s*=\s*(?:"(?<dq>[^"]*)"|'(?<sq>[^']*)'|(?<bare>[^\s>]+))/g;

/** Extract icon hrefs from HTML, resolved against the page URL. */
export function findIconHrefs(html: string, baseUrl: string): string[] {
	const out: string[] = [];
	for (const tag of html.match(LINK_TAG) ?? []) {
		const attrs = new Map<string, string>();
		for (const m of tag.matchAll(ATTR)) {
			const g = m.groups;
			if (g) attrs.set(g.name.toLowerCase(), g.dq || g.sq || g.bare || '');
		}
		const rel = (attrs.get('rel') ?? '').toLowerCase();
		if (!rel.includes('icon')) continue;
		const href = attrs.get('href');
		if (!href) continue;
		try {
			const resolved = new URL(href, baseUrl);
			if (isHttpUrl(resolved.href)) out.push(resolved.href);
		} catch {
			continue;
		}
	}
	return out;
}
