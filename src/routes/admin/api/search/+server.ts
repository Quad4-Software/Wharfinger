import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { can } from '$lib/server/admin/authz';
import { apiJson, requireUser } from '$lib/server/admin/http';

export interface SearchHit {
	kind:
		'service' | 'page' | 'incident' | 'maintenance' | 'agent' | 'user' | 'room' | 'issue' | 'audit';
	id: string;
	title: string;
	sub: string;
	/** Admin-relative path the palette navigates to. */
	href: string;
}

const QUERY_MAX = 80;
const PER_KIND = 6;

function hits(haystack: (string | null | undefined)[], q: string): boolean {
	return haystack.some((h) => h?.toLowerCase().includes(q) === true);
}

/**
 * Cross-entity search for the command palette. Each source is gated on
 * the same permission its admin view requires, and results carry
 * admin-relative hrefs so the client prefixes the configured base path.
 */
export const GET: RequestHandler = async (event) => {
	const rt = getRuntime();
	const user = requireUser(event);
	const q = (event.url.searchParams.get('q') ?? '').trim().toLowerCase().slice(0, QUERY_MAX);
	if (q.length < 2) return apiJson({ results: [] });

	const { snapshot } = await rt.snapshot.current();
	const results: SearchHit[] = [];

	for (const g of snapshot.groups) {
		for (const s of g.services) {
			if (hits([s.name, s.id, g.name], q)) {
				results.push({
					kind: 'service',
					id: s.id,
					title: s.name,
					sub: `${g.name} · ${s.status}`,
					href: '/services'
				});
			}
			if (results.length >= PER_KIND * 2) break;
		}
	}

	for (const p of snapshot.pages) {
		if (hits([p.title, p.slug, p.description], q)) {
			results.push({
				kind: 'page',
				id: p.slug,
				title: p.title,
				sub: `/p/${p.slug}`,
				href: '/pages'
			});
		}
	}

	const incidents = [...snapshot.incidents.active, ...snapshot.incidents.recent];
	for (const i of incidents) {
		if (hits([i.title, i.severity, ...i.services], q)) {
			results.push({
				kind: 'incident',
				id: i.id,
				title: i.title,
				sub: i.resolvedAt ? 'resolved' : `active · ${i.severity}`,
				href: '/incidents'
			});
		}
	}

	for (const m of [...snapshot.maintenance.active, ...snapshot.maintenance.upcoming]) {
		if (hits([m.title, ...m.services], q)) {
			results.push({
				kind: 'maintenance',
				id: m.id,
				title: m.title,
				sub: m.active ? 'in progress' : 'scheduled',
				href: '/maintenance'
			});
		}
	}

	const tasks: Promise<void>[] = [];

	if (await can(rt.roles, user, 'agents.manage')) {
		tasks.push(
			rt.agents.list().then((agents) => {
				for (const a of agents) {
					if (hits([a.name, a.id], q)) {
						results.push({
							kind: 'agent',
							id: a.id,
							title: a.name,
							sub: 'system',
							href: `/agents/${a.id}`
						});
					}
				}
			})
		);
	}

	if (await can(rt.roles, user, 'users.manage')) {
		tasks.push(
			rt.users.all().then((users) => {
				for (const u of users) {
					if (hits([u.username, u.displayName, u.role], q)) {
						results.push({
							kind: 'user',
							id: String(u.id),
							title: u.displayName || u.username,
							sub: u.role,
							href: '/users'
						});
					}
				}
			})
		);
	}

	tasks.push(
		rt.chat.listRoomsFor(user.id).then((rooms) => {
			for (const r of rooms) {
				const names = r.members.map((m) => m.displayName || m.username);
				const title = r.name || names.filter((_, i) => r.members[i].id !== user.id).join(', ');
				if (hits([title, ...names], q)) {
					results.push({
						kind: 'room',
						id: r.id,
						title: title || 'Chat',
						sub: r.kind === 'dm' ? 'direct message' : `${r.members.length} members`,
						href: `/chat?room=${encodeURIComponent(r.id)}`
					});
				}
			}
		})
	);

	if (await can(rt.roles, user, 'telemetry.view')) {
		tasks.push(
			rt.telemetry.issues(null, { limit: PER_KIND, q }).then(({ entries }) => {
				for (const i of entries) {
					results.push({
						kind: 'issue',
						id: `${i.projectId}:${i.fingerprint}`,
						title: i.title,
						sub: i.culprit ?? 'telemetry issue',
						href: '/telemetry'
					});
				}
			})
		);
	}

	if (await can(rt.roles, user, 'audit.view')) {
		tasks.push(
			rt.audit.list({ limit: PER_KIND, offset: 0, q }).then(({ entries }) => {
				for (const e of entries) {
					results.push({
						kind: 'audit',
						id: String(e.id),
						title: `${e.action} · ${e.username ?? 'system'}`,
						sub: e.detail ?? '',
						href: '/audit'
					});
				}
			})
		);
	}

	await Promise.all(tasks);
	return apiJson({ results: results.slice(0, 40) });
};
