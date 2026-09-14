import { worstStatus } from './status';
import type { PageMeta, StatusSnapshot } from './types';

// Multi-page filtering, isomorphic: the server uses it for SSR of
// /p/<slug> routes and the client reuses it to re-filter pushed
// snapshots over SSE.

/** Does the page cover this service id? services = ['*'] means all. */
export function pageCovers(page: PageMeta, serviceId: string): boolean {
	return page.services.includes('*') || page.services.includes(serviceId);
}

/**
 * Project a full snapshot into one status page: services filtered to the
 * page's list, incidents and maintenance filtered by intersection, and
 * site presentation overridden by the page's own title/description/
 * accent when set.
 */
export function filterSnapshot(snap: StatusSnapshot, page: PageMeta): StatusSnapshot {
	const covered = new Set(
		page.services.includes('*')
			? snap.groups.flatMap((g) => g.services.map((s) => s.id))
			: page.services
	);

	const groups = snap.groups
		.map((g) => ({ ...g, services: g.services.filter((s) => covered.has(s.id)) }))
		.filter((g) => g.services.length > 0);

	// Only offer filter chips for groups that cover at least one visible
	// service; otherwise a chip would filter the page down to nothing.
	const referenced = new Set(groups.flatMap((g) => g.services.flatMap((s) => s.groupIds)));

	const inScope = (services: string[]) =>
		services.includes('*') || services.some((s) => covered.has(s));

	return {
		...snap,
		site: {
			...snap.site,
			title: page.title,
			description: page.description ?? snap.site.description,
			accent: page.accent ?? snap.site.accent
		},
		overall: worstStatus(groups.flatMap((g) => g.services.map((s) => s.status))),
		groups,
		serviceGroups: snap.serviceGroups.filter((g) => referenced.has(g.id)),
		incidents: {
			active: snap.incidents.active.filter((i) => inScope(i.services)),
			recent: snap.incidents.recent.filter((i) => inScope(i.services))
		},
		maintenance: {
			active: snap.maintenance.active.filter((w) => inScope(w.services)),
			upcoming: snap.maintenance.upcoming.filter((w) => inScope(w.services))
		}
	};
}
