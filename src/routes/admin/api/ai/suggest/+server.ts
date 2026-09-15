import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, readJson, requirePerm } from '$lib/server/admin/http';
import { aiChat } from '$lib/server/ai/provider';
import { buildContext, sanitize } from '$lib/server/ai/context';
import { SUGGEST_PROMPT, parseSuggestions, resolveSuggestions } from '$lib/server/ai/suggest';
import { RateLimiter } from '$lib/server/http/ratelimit';

const aiLimiter = new RateLimiter(8, 60_000);

/**
 * Suggested actions, never automatic: the model proposes from a fixed
 * catalog, the resolver drops anything that does not resolve to a real
 * audited route, and the UI must call that route with an authenticated
 * click for anything to happen.
 */
export const POST: RequestHandler = async (event) => {
	const user = requirePerm(event, 'ai.use');
	const rt = getRuntime();
	if (!rt.config.ai.enabled) return apiError(404, 'ai is not enabled');
	if (!aiLimiter.allow(`u${user.id}`)) {
		return apiError(429, 'ai rate limit exceeded; try again in a minute');
	}

	const body = await readJson<{ serviceId?: unknown; incidentId?: unknown }>(event.request, 8192);
	const { context } = await buildContext(rt, {
		serviceId: typeof body.serviceId === 'string' ? sanitize(body.serviceId, 80) : undefined,
		incidentId: typeof body.incidentId === 'string' ? sanitize(body.incidentId, 80) : undefined
	});

	const res = await aiChat(rt.config.ai, rt.egress, [
		{ role: 'system', content: SUGGEST_PROMPT },
		{ role: 'user', content: `CONTEXT:\n${context}` }
	]);
	if (!res.ok) return apiError(502, res.error ?? 'provider error');

	const suggestions = await resolveSuggestions(rt, parseSuggestions(res.text));
	await audit(rt, event, 'ai.suggest', `n=${suggestions.length}`);
	return apiJson({ ok: true, suggestions, generated: true });
};
