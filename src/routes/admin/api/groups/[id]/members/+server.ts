import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, readJson, requirePerm } from '$lib/server/admin/http';
import { getGroupStore, GroupError } from '$lib/server/groups/store';
import type { GroupMember } from '$lib/shared/groups';

const MAX_OPS = 200;

function parseMembers(v: unknown): GroupMember[] | null {
	if (!Array.isArray(v) || v.length > MAX_OPS) return null;
	const out: GroupMember[] = [];
	for (const e of v) {
		if (e === null || typeof e !== 'object' || Array.isArray(e)) return null;
		const kind = (e as Record<string, unknown>).memberKind;
		const id = (e as Record<string, unknown>).memberId;
		if ((kind !== 'service' && kind !== 'app') || typeof id !== 'string') return null;
		out.push({ memberKind: kind, memberId: id });
	}
	return out;
}

interface PutBody {
	add?: unknown;
	remove?: unknown;
}

export const PUT: RequestHandler = async (event) => {
	requirePerm(event, 'groups.manage');
	const rt = getRuntime();
	const id = event.params.id;
	const body = await readJson<PutBody>(event.request, 32 * 1024);
	const add = parseMembers(body.add ?? []);
	const remove = parseMembers(body.remove ?? []);
	if (add === null || remove === null) {
		return apiError(422, 'add and remove must be arrays of {memberKind, memberId}');
	}
	try {
		const group = await getGroupStore(rt.db).setMembers(id, add, remove);
		await audit(rt, event, 'group.members', `id=${id} +${add.length} -${remove.length}`);
		rt.snapshot.invalidate();
		return apiJson({ ok: true, group });
	} catch (err) {
		if (err instanceof GroupError) return apiError(err.status, err.message);
		throw err;
	}
};
