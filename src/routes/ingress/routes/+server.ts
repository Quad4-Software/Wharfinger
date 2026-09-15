import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { bearerToken, gate, proofGate } from '$lib/server/ingress/http';
import { routeTable } from '$lib/server/edge/table';

/**
 * Agent route-table sync. Pull model, same as jobs: the agent polls
 * and swaps the result atomically. GETs carry no body, so the
 * proofGate input is the request target bytes ("GET <path><query>")
 * which the agent signs identically; the proof then also covers the
 * ?v= stamp. Clients send the last seen version via ?v= or
 * If-None-Match and get a 304 when the table is unchanged.
 */
export const GET: RequestHandler = async (event) => {
	const rt = getRuntime();
	const g = await gate(rt, rt.agents, bearerToken(event.request));
	if (g.err) return g.err;

	const target = Buffer.from(`GET ${event.url.pathname}${event.url.search}`, 'utf8');
	const badProof = await proofGate(rt, g.agent, event.request, target);
	if (badProof) return badProof;

	const table = await routeTable(rt.db, g.agent.id);
	const etag = String(table.version);
	const seen = event.url.searchParams.get('v') ?? event.request.headers.get('if-none-match');
	if (seen !== null && seen === etag) {
		return new Response(null, { status: 304, headers: { etag } });
	}
	return json(table, { headers: { etag } });
};
