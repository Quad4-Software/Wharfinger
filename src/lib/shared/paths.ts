// Central route map. Both server endpoints and client fetches reference
// these so paths never drift between the two sides.

export const paths = {
	root: '/',
	page: (slug: string) => `/p/${slug}`,
	apiStatus: '/api/status',
	apiStream: '/api/stream',
	apiHistory: (serviceId: string, range?: string) =>
		`/api/history/${serviceId}${range ? `?range=${range}` : ''}`,
	badge: (serviceId: string) => `/badge/${serviceId}.svg`,
	favicon: (serviceId: string) => `/favicon/${serviceId}`,
	feed: '/feed.xml',
	healthz: '/healthz',
	robots: '/robots.txt',
	sitemap: '/sitemap.xml',
	apiTelemetry: '/api/telemetry'
} as const;

// Path prefixes that get public cross-origin and rate-limit treatment in
// hooks.server.ts.
export const PUBLIC_API_PREFIX = '/api/';
export const PUBLIC_BADGE_PREFIX = '/badge/';
export const PUBLIC_FAVICON_PREFIX = '/favicon/';
// The external admin mount path is configurable via admin.base_path;
// internals always route under /admin.
