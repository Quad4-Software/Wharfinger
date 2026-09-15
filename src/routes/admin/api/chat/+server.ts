import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiJson, requireUser } from '$lib/server/admin/http';
import { chatPresence } from '$lib/server/admin/chat-bus';
import type { ChatPresenceMap } from '$lib/shared/chat';

// Room list with members, unread counts, and previews, plus the
// presence map. Socket-derived states (production bridge) win over
// the store's activity-derived fallback so a closed socket reads
// offline even when the user just polled.
export const GET: RequestHandler = async (event) => {
	const rt = getRuntime();
	const user = requireUser(event);
	rt.chat.touch(user.id);
	const rooms = await rt.chat.listRoomsFor(user.id);
	const ids = new Set<number>([user.id]);
	for (const r of rooms) for (const m of r.members) ids.add(m.id);
	const live = chatPresence();
	const presence: ChatPresenceMap = {};
	for (const id of ids) {
		presence[String(id)] = live?.[String(id)] ?? rt.chat.presenceFor(id);
	}
	return apiJson({ rooms, presence });
};
