import type { RequestHandler } from './$types';
import type { NotifyFeedItem } from '$lib/shared/types';
import { getRuntime } from '$lib/server/runtime';
import { apiJson, requireUser } from '$lib/server/admin/http';

// Notification-center feed for the admin shell bell. Items are
// composed from signal sources the caller can already see: their own
// unread chat, active incidents, and recent notification deliveries.
// Audit entries are deliberately excluded: the audit log is a record,
// not an alert stream, and routine writes would bury real signals.
// hrefs are panel-relative; the client prefixes the configured admin
// base path.

export const GET: RequestHandler = async (event) => {
	const rt = getRuntime();
	const user = requireUser(event);
	const perms = event.locals.perms;
	const items: NotifyFeedItem[] = [];

	for (const room of await rt.chat.listRoomsFor(user.id)) {
		if (room.unread <= 0) continue;
		items.push({
			kind: 'chat',
			title: room.name || 'Direct message',
			sub: `${room.unread} unread ${room.unread === 1 ? 'message' : 'messages'}`,
			at: room.preview?.at ?? room.createdAt,
			href: '/chat'
		});
	}

	if (perms?.has('status.view')) {
		const snap = await rt.snapshot.current();
		for (const inc of snap.snapshot.incidents.active) {
			items.push({
				kind: 'incident',
				title: inc.title,
				sub: `${inc.severity} incident`,
				at: Date.parse(inc.startedAt),
				href: '/incidents'
			});
		}
		for (const e of await rt.notifyLog.recent(10)) {
			items.push({
				kind: 'delivery',
				title: `${e.event} -> ${e.target}`,
				sub: e.ok ? 'delivered' : `failed: ${e.error ?? `HTTP ${e.status ?? '?'}`}`,
				at: e.at,
				href: '/notifications'
			});
		}
	}

	items.sort((a, b) => b.at - a.at);
	return apiJson({ items: items.slice(0, 25) });
};
