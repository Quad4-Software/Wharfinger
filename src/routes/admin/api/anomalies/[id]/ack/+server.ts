import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, requirePerm } from '$lib/server/admin/http';
import { getEngine } from '$lib/server/anomaly/engine';

export const POST: RequestHandler = async (event) => {
	const user = requirePerm(event, 'anomaly.view');
	const rt = getRuntime();
	const id = Number(event.params.id);
	if (!Number.isInteger(id) || id <= 0) return apiError(422, 'invalid anomaly id');
	const anomaly = await getEngine(rt.db).ack(id, user.username);
	if (!anomaly) return apiError(404, 'anomaly not found');
	await audit(rt, event, 'anomaly.ack', `id=${id} metric=${anomaly.metric}`);
	return apiJson({ ok: true, anomaly });
};
