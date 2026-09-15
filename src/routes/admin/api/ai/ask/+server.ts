import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, readJson, requirePerm } from '$lib/server/admin/http';
import { aiChat } from '$lib/server/ai/provider';
import { SYSTEM_PROMPT, buildContext, sanitize } from '$lib/server/ai/context';
import { RateLimiter } from '$lib/server/http/ratelimit';

const MAX_QUESTION = 2000;
// The assistant is an upstream cost center: per-user asks stay modest
// so a scripted caller cannot run the provider bill up.
const aiLimiter = new RateLimiter(12, 60_000);

/**
 * Panel assistant Q&A. Builds a sanitized context block from the
 * status snapshot, incidents, and agent inventory, asks the
 * configured provider, and returns the answer with its sources so the
 * UI can label the response as generated.
 */
export const POST: RequestHandler = async (event) => {
	const user = requirePerm(event, 'ai.use');
	const rt = getRuntime();
	if (!rt.config.ai.enabled) return apiError(404, 'ai is not enabled');

	if (!aiLimiter.allow(`u${user.id}`)) {
		return apiError(429, 'ai rate limit exceeded; try again in a minute');
	}
	const body = await readJson<{
		question?: unknown;
		serviceId?: unknown;
		incidentId?: unknown;
	}>(event.request, 8192);
	const question = typeof body.question === 'string' ? body.question.trim() : '';
	if (!question || question.length > MAX_QUESTION) {
		return apiError(422, `question must be 1-${MAX_QUESTION} characters`);
	}

	const { context, sources } = await buildContext(rt, {
		serviceId: typeof body.serviceId === 'string' ? sanitize(body.serviceId, 80) : undefined,
		incidentId: typeof body.incidentId === 'string' ? sanitize(body.incidentId, 80) : undefined
	});

	const res = await aiChat(rt.config.ai, rt.egress, [
		{ role: 'system', content: SYSTEM_PROMPT },
		{ role: 'user', content: `CONTEXT:\n${context}\n\nQUESTION: ${question}` }
	]);
	if (!res.ok) return apiError(502, res.error ?? 'provider error');
	await audit(rt, event, 'ai.ask', `q=${question.slice(0, 80)}`);
	return apiJson({ ok: true, answer: res.text, sources, generated: true });
};
