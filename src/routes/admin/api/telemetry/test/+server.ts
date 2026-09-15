import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, requirePerm } from '$lib/server/admin/http';
import { sendTestEvent } from '$lib/server/telemetry';

export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	requirePerm(event, 'admin.settings');
	const result = await sendTestEvent();
	void audit(rt, event, 'telemetry.test', `ok=${String(result.ok)}`);
	if (!result.ok) return apiError(502, result.error ?? 'delivery failed');
	return apiJson({ ok: true });
};
