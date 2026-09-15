import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { SectionError, saveSectionValue } from '$lib/server/admin/config-actions';
import {
	apiError,
	apiJson,
	asArray,
	asString,
	clientIp,
	readJson,
	requirePerm
} from '$lib/server/admin/http';

function parseId(raw: string): { kind: 'auto' | 'manual'; n: number } | null {
	const m = /^(auto|manual)-(\d+)$/.exec(raw);
	if (!m) return null;
	return { kind: m[1] as 'auto' | 'manual', n: Number(m[2]) };
}

/** Post an operator update onto an incident. */
export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const user = requirePerm(event, 'status.manage');
	const id = parseId(event.params.id);
	if (!id) return apiError(404, 'unknown incident');
	const body = await readJson<{ message?: unknown }>(event.request, 16 * 1024);
	const message = asString(body.message, 2000);
	if (!message) return apiError(422, 'message is required');
	const ip = clientIp(event);

	if (id.kind === 'auto') {
		const row = await rt.incidents.byId(id.n);
		if (!row) return apiError(404, 'unknown incident');
		await rt.incidents.addUpdate(id.n, message, user.username);
		await rt.audit.log({
			userId: user.id,
			username: user.username,
			action: 'incident.update',
			detail: `auto-${id.n}`,
			ip
		});
	} else {
		const raw = rt.effective().raw;
		const incidents = asArray(raw.incidents);
		const entry = incidents[id.n] as Record<string, unknown> | undefined;
		if (!entry) return apiError(404, 'unknown incident');
		const updates = asArray(entry.updates);
		updates.push({ at: new Date().toISOString(), message });
		incidents[id.n] = { ...entry, updates };
		try {
			await saveSectionValue(rt, user, ip, 'incidents', incidents, undefined, 'incident.update');
		} catch (err) {
			if (err instanceof SectionError) {
				return apiError(err.status, err.message, err.issues ? { issues: err.issues } : undefined);
			}
			throw err;
		}
	}
	rt.snapshot.invalidate();
	return apiJson({ ok: true });
};

/** Resolve an open incident. */
export const PATCH: RequestHandler = async (event) => {
	const rt = getRuntime();
	const user = requirePerm(event, 'status.manage');
	const id = parseId(event.params.id);
	if (!id) return apiError(404, 'unknown incident');
	const ip = clientIp(event);

	if (id.kind === 'auto') {
		if (!(await rt.incidents.resolve(id.n))) {
			return apiError(409, 'incident is already resolved');
		}
		await rt.audit.log({
			userId: user.id,
			username: user.username,
			action: 'incident.resolve',
			detail: `auto-${id.n}`,
			ip
		});
	} else {
		const raw = rt.effective().raw;
		const incidents = asArray(raw.incidents);
		const entry = incidents[id.n] as Record<string, unknown> | undefined;
		if (!entry) return apiError(404, 'unknown incident');
		if (entry.resolved_at) return apiError(409, 'incident is already resolved');
		incidents[id.n] = { ...entry, resolved_at: new Date().toISOString() };
		try {
			await saveSectionValue(rt, user, ip, 'incidents', incidents, undefined, 'incident.resolve');
		} catch (err) {
			if (err instanceof SectionError) {
				return apiError(err.status, err.message, err.issues ? { issues: err.issues } : undefined);
			}
			throw err;
		}
	}
	rt.snapshot.invalidate();
	return apiJson({ ok: true });
};

/** Remove a manual incident entirely. Auto incidents cannot be deleted. */
export const DELETE: RequestHandler = async (event) => {
	const rt = getRuntime();
	const user = requirePerm(event, 'status.manage');
	const id = parseId(event.params.id);
	if (!id) return apiError(404, 'unknown incident');
	if (id.kind === 'auto') {
		return apiError(422, 'auto incidents are managed by the monitor; resolve instead');
	}
	const raw = rt.effective().raw;
	const incidents = asArray(raw.incidents);
	if (!incidents[id.n]) return apiError(404, 'unknown incident');
	incidents.splice(id.n, 1);
	try {
		await saveSectionValue(
			rt,
			user,
			clientIp(event),
			'incidents',
			incidents,
			undefined,
			'incident.delete'
		);
	} catch (err) {
		if (err instanceof SectionError) {
			return apiError(err.status, err.message, err.issues ? { issues: err.issues } : undefined);
		}
		throw err;
	}
	return apiJson({ ok: true });
};
