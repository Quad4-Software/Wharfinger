import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, requirePerm } from '$lib/server/admin/http';

/** Revoke an invite by its (truncated) hash prefix as listed in the UI. */
export const DELETE: RequestHandler = async (event) => {
	const rt = getRuntime();
	requirePerm(event, 'invites.manage');
	const prefix = event.params.hash;
	// The UI lists 16-char prefixes; a floor keeps an empty or tiny
	// prefix from matching an arbitrary invite.
	if (prefix.length < 8) return apiError(422, 'hash prefix too short');
	const match = (await rt.invites.recent(500)).find((i) => i.tokenHash.startsWith(prefix));
	if (!match) return apiError(404, 'unknown invite');
	await rt.invites.revoke(match.tokenHash);
	await audit(rt, event, 'invites.revoke', `kind=${match.kind} role=${match.role}`);
	return apiJson({ ok: true });
};
