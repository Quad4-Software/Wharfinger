import * as v from 'valibot';
import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { Service } from '$lib/server/config/schema';
import { runCheck } from '$lib/server/monitor/checkers';
import { apiError, apiJson, audit, readJson, requirePerm } from '$lib/server/admin/http';
import { interpolateEnv } from '$lib/server/config/load';

/**
 * Dry-run a service check. Accepts either an existing service id or a
 * full raw service definition (for testing an unsaved editor draft).
 * Results are never recorded.
 *
 * ${VAR} expansion only applies to definitions that come from the TOML
 * file. Panel-supplied bodies and sqlite overrides never interpolate,
 * otherwise this endpoint would hand a status.manage user read access
 * to every process environment variable.
 */
export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const user = requirePerm(event, 'status.manage');
	const body = await readJson<{ id?: string; service?: unknown }>(event.request, 32 * 1024);

	let raw: unknown = body.service;
	let fromFile = false;
	if (raw === undefined) {
		const id = typeof body.id === 'string' ? body.id : null;
		if (!id) return apiError(422, 'provide id or service');
		const eff = rt.effective();
		raw = Array.isArray(eff.raw.services)
			? eff.raw.services.find((s) => (s as { id?: string }).id === id)
			: undefined;
		if (raw === undefined) return apiError(404, 'unknown service');
		// When the services section has no override the whole list is
		// file content, so placeholders may be resolved like the monitor
		// does. An overridden list is panel input and stays literal.
		fromFile = !eff.overrides.has('services');
	}
	if (fromFile) raw = interpolateEnv(raw);

	const parsed = v.safeParse(Service, raw);
	if (!parsed.success) {
		return apiError(422, 'invalid service definition', {
			issues: parsed.issues.map((i) => i.message).join('; ')
		});
	}
	const svc = parsed.output;
	const outcome = await runCheck(svc, {
		timeoutMs: svc.timeout_ms ?? rt.config.monitor.default_timeout_ms,
		degradedMs: svc.degraded_ms ?? rt.config.monitor.default_degraded_ms,
		userAgent: rt.monitor.userAgent,
		certWarnDays: rt.config.monitor.cert_warn_days,
		egress: rt.egress
	});
	void audit(rt, event, 'services.check', `id=${svc.id} type=${svc.type} by=${user.username}`);
	return apiJson({
		ok: outcome.ok,
		degraded: outcome.degraded,
		latencyMs: outcome.latencyMs,
		detail: outcome.detail ?? null,
		certDays: outcome.certDays ?? null
	});
};
