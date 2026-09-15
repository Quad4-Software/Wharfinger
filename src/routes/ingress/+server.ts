import * as v from 'valibot';
import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, readText } from '$lib/server/admin/http';
import { bearerToken, gate, proofGate } from '$lib/server/ingress/http';
import { AgentPayload } from '$lib/server/ingress/schema';

// Agent clock drift allowance. Rejecting wild timestamps keeps the
// sample index sane without requiring NTP-grade sync on hosts.
const MAX_SKEW_MS = 3600_000;
// Backfill (store-and-forward after an outage) gets a wider window,
// still bounded so ancient or future-dated rows cannot pollute the
// series. Anything older is pruned by retention anyway.
const BACKFILL_AGE_MS = 48 * 3600_000;
const BACKFILL_FUTURE_MS = 60_000;

/** Metrics ingest. Bearer token in the Authorization header. */
export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const g = await gate(rt, rt.agents, bearerToken(event.request));
	if (g.err) return g.err;

	const text = await readText(event.request, rt.config.ingress.max_body_kb * 1024);
	const bodyBytes = Buffer.from(text, 'utf8');

	const badProof = await proofGate(rt, g.agent, event.request, bodyBytes);
	if (badProof) return badProof;

	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return apiError(400, 'expected a JSON body');
	}
	const parsed = v.safeParse(AgentPayload, body);
	if (!parsed.success) {
		return apiError(422, 'invalid payload', {
			issues: parsed.issues.slice(0, 5).map((i) => i.message)
		});
	}
	const p = parsed.output;
	const now = Date.now();
	const tsOk = p.backfill
		? p.ts <= now + BACKFILL_FUTURE_MS && p.ts >= now - BACKFILL_AGE_MS
		: Math.abs(p.ts - now) <= MAX_SKEW_MS;
	if (!tsOk) {
		return apiError(422, 'payload timestamp out of accepted window');
	}

	const fp = await rt.agents.checkFingerprint(g.agent, p.fingerprint);
	if (fp === 'mismatch') {
		return apiError(403, 'fingerprint mismatch: this token is bound to another machine');
	}

	await rt.agents.record(g.agent.id, p);
	// Backfill is stale by definition: it fills the series but must not
	// drive threshold alerts off old data.
	if (!p.backfill) await rt.alerter.onSample(g.agent, p);
	// Piggyback queued-work count so agents learn about pending jobs
	// on their normal send cadence without a separate poll. The ws
	// bridge relays this response body verbatim.
	return apiJson({ ok: true, pending: await rt.jobs.pending(g.agent.id) });
};
