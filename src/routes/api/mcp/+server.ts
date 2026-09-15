import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiKeyOrResponse } from '$lib/server/apikey';
import { handleMcp } from '$lib/server/ai/mcp';
import { readText } from '$lib/server/admin/http';

const MAX_BODY = 32 * 1024;

/**
 * MCP endpoint: JSON-RPC over POST with a qs_ read-scoped bearer key.
 * Gated on [ai].mcp_enabled so the surface stays closed unless an
 * admin turns it on. Notifications answer 202; everything else is a
 * JSON-RPC reply.
 */
export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	if (!rt.config.ai.mcp_enabled) return new Response(null, { status: 404 });

	const auth = await apiKeyOrResponse(rt, event.request, 'read');
	if ('res' in auth) return auth.res;

	const text = await readText(event.request, MAX_BODY);
	let msg: unknown;
	try {
		msg = JSON.parse(text);
	} catch {
		return Response.json(
			{ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } },
			{ status: 400 }
		);
	}
	if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
		return Response.json(
			{ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'single requests only' } },
			{ status: 400 }
		);
	}
	const out = await handleMcp(rt, msg);
	if (out === null) return new Response(null, { status: 202 });
	return Response.json(out);
};

// MCP probes sometimes GET for a streamable-http handshake; this
// endpoint is POST-only, so answer 405 without touching auth.
export const GET: RequestHandler = () => new Response(null, { status: 405 });
