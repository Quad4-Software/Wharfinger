import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import {
	SectionError,
	isSectionKey,
	resetSection,
	saveSectionValue,
	sectionView
} from '$lib/server/admin/config-actions';
import { sectionPermission, sectionReadPermission } from '$lib/server/admin/authz';
import { apiError, apiJson, clientIp, readJson, requirePerm } from '$lib/server/admin/http';

function sectionOr404(params: { section?: string }) {
	const s = params.section;
	if (!s || !isSectionKey(s)) return null;
	return s;
}

export const GET: RequestHandler = (event) => {
	const rt = getRuntime();
	const section = sectionOr404(event.params);
	if (!section) return apiError(404, 'unknown section');
	requirePerm(event, sectionReadPermission(section));
	return apiJson(sectionView(rt, section));
};

export const PUT: RequestHandler = async (event) => {
	const rt = getRuntime();
	const section = sectionOr404(event.params);
	if (!section) return apiError(404, 'unknown section');
	const user = requirePerm(event, sectionPermission(section));
	const body = await readJson<{ value?: unknown; expected?: number | null }>(event.request);
	if (!('value' in body)) return apiError(422, 'missing value');
	try {
		const result = saveSectionValue(
			rt,
			user,
			clientIp(event),
			section,
			body.value,
			body.expected === undefined ? undefined : body.expected
		);
		return apiJson(result);
	} catch (err) {
		if (err instanceof SectionError) {
			return apiError(err.status, err.message, err.issues ? { issues: err.issues } : undefined);
		}
		throw err;
	}
};

export const DELETE: RequestHandler = (event) => {
	const rt = getRuntime();
	const section = sectionOr404(event.params);
	if (!section) return apiError(404, 'unknown section');
	const user = requirePerm(event, sectionPermission(section));
	try {
		return apiJson(resetSection(rt, user, clientIp(event), section));
	} catch (err) {
		if (err instanceof SectionError) {
			return apiError(err.status, err.message, err.issues ? { issues: err.issues } : undefined);
		}
		throw err;
	}
};
