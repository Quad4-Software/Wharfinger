import type { Runtime } from '$lib/server/runtime';
import { sanitize } from './context';
import { agentView } from '$lib/server/ingress/view';

/**
 * Minimal MCP (JSON-RPC) read-only server. The tool list is a pinned
 * constant: no dynamic mutation, no prompts or resources, no remote
 * tool descriptions. Every tool output is sanitized JSON capped at
 * 32 KiB so a huge fleet cannot produce an unbounded frame.
 */

const MAX_TOOL_BYTES = 32 * 1024;
const PROTOCOL_VERSION = '2025-03-26';

interface JsonRpc {
	jsonrpc?: unknown;
	id?: unknown;
	method?: unknown;
	params?: unknown;
}

export const MCP_TOOLS = [
	{
		name: 'list_services',
		description: 'List monitored services with status, latency, and 24h uptime',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false }
	},
	{
		name: 'get_service',
		description: 'Get one service by name or id: status, detail, uptime, cert days',
		inputSchema: {
			type: 'object',
			properties: { name: { type: 'string' } },
			required: ['name'],
			additionalProperties: false
		}
	},
	{
		name: 'list_incidents',
		description: 'List active and recent incidents with their update count',
		inputSchema: {
			type: 'object',
			properties: { active_only: { type: 'boolean' } },
			additionalProperties: false
		}
	},
	{
		name: 'list_agents',
		description: 'List registered agents: name, online state, version, active alerts',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false }
	},
	{
		name: 'list_jobs',
		description: 'List recent deploy/task jobs with kind, status, and target',
		inputSchema: {
			type: 'object',
			properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } },
			additionalProperties: false
		}
	}
] as const;

function toolText(data: unknown): { content: { type: 'text'; text: string }[] } {
	let text = JSON.stringify(data, null, 1);
	if (text.length > MAX_TOOL_BYTES) text = text.slice(0, MAX_TOOL_BYTES) + '\n… truncated';
	return { content: [{ type: 'text', text }] };
}

function toolErr(msg: string) {
	return { content: [{ type: 'text', text: msg }], isError: true };
}

async function callTool(rt: Runtime, name: string, args: unknown): Promise<unknown> {
	const a = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
	const snap = (await rt.snapshot.current()).snapshot;

	switch (name) {
		case 'list_services':
			return toolText(
				snap.groups.flatMap((g) =>
					g.services.map((s) => ({
						name: sanitize(s.name, 80),
						status: s.status,
						latencyMs: s.latencyMs,
						uptime24h: s.uptime.d24,
						maintenance: s.inMaintenance || undefined
					}))
				)
			);
		case 'get_service': {
			const wanted = sanitize(a.name, 80);
			const svc = snap.groups
				.flatMap((g) => g.services)
				.find((s) => s.id === wanted || s.name === wanted);
			if (!svc) return toolErr(`service ${wanted || '?'} not found`);
			return toolText({
				name: sanitize(svc.name, 80),
				status: svc.status,
				latencyMs: svc.latencyMs,
				uptime: svc.uptime,
				lastDetail: svc.lastDetail ? sanitize(svc.lastDetail, 200) : null,
				certDays: svc.certDays,
				inMaintenance: svc.inMaintenance
			});
		}
		case 'list_incidents': {
			const list =
				a.active_only === true
					? snap.incidents.active
					: [...snap.incidents.active, ...snap.incidents.recent];
			return toolText(
				list.slice(0, 25).map((i) => ({
					title: sanitize(i.title, 100),
					severity: i.severity,
					services: i.services.map((s) => sanitize(s, 80)),
					startedAt: i.startedAt,
					resolvedAt: i.resolvedAt,
					updates: i.updates.length
				}))
			);
		}
		case 'list_agents': {
			const rows = await rt.agents.list();
			const windowMs = rt.config.ingress.online_seconds * 1000;
			return toolText(
				rows.slice(0, 50).map((r) => {
					const v = agentView(r, windowMs);
					return {
						name: sanitize(v.name, 80),
						online: v.online,
						version: v.meta?.version ? sanitize(v.meta.version, 24) : null,
						os: v.meta?.os ? sanitize(v.meta.os, 24) : null,
						alerts: v.alerts,
						updates: v.summary?.updates ?? undefined
					};
				})
			);
		}
		case 'list_jobs': {
			const limit = Math.min(Math.max(Number(a.limit) || 20, 1), 50);
			const jobs = await rt.jobs.list({ limit });
			return toolText(
				jobs.map((j) => ({
					id: j.id,
					kind: j.kind,
					status: j.status,
					target: j.target,
					createdAt: j.createdAt
				}))
			);
		}
		default:
			return toolErr(`unknown tool ${sanitize(name, 40)}`);
	}
}

/**
 * Handle one JSON-RPC message. Returns null for notifications (the
 * route answers 202) and a JSON-RPC result/error object otherwise.
 */
export async function handleMcp(rt: Runtime, msg: JsonRpc): Promise<unknown> {
	const method = typeof msg.method === 'string' ? msg.method : '';
	const id = msg.id ?? null;

	const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result });
	const fail = (code: number, message: string) => ({
		jsonrpc: '2.0',
		id,
		error: { code, message }
	});

	switch (method) {
		case 'notifications/initialized':
		case 'notifications/cancelled':
			return null;
		case 'initialize':
			return reply({
				protocolVersion: PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: { name: 'wharfinger', version: '1' }
			});
		case 'ping':
			return reply({});
		case 'tools/list':
			return reply({ tools: MCP_TOOLS });
		case 'tools/call': {
			const params = (typeof msg.params === 'object' && msg.params !== null ? msg.params : {}) as {
				name?: unknown;
				arguments?: unknown;
			};
			const name = sanitize(params.name, 60);
			if (!MCP_TOOLS.some((t) => t.name === name)) {
				return fail(-32602, `unknown tool ${name || '?'}`);
			}
			try {
				return reply(await callTool(rt, name, params.arguments));
			} catch (err) {
				return fail(-32603, err instanceof Error ? err.message : 'tool failed');
			}
		}
		default:
			return fail(-32601, `method ${sanitize(method, 40) || '?'} not supported`);
	}
}
