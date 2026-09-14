import { describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { User } from '$lib/server/admin/users';
import { GET as listAgents, POST as createAgent } from '../../src/routes/admin/api/agents/+server';
import {
	GET as getAgent,
	PATCH as patchAgent,
	DELETE as deleteAgent
} from '../../src/routes/admin/api/agents/[id]/+server';
import { GET as getHistory } from '../../src/routes/admin/api/agents/[id]/history/+server';
import { GET as getEdge } from '../../src/routes/admin/api/agents/[id]/edge/+server';
import { POST as rotateHubKey } from '../../src/routes/admin/api/agents/rotate-hub-key/+server';

const operator: User = {
	id: 2,
	username: 'ops',
	displayName: '',
	role: 'operator',
	totpEnabled: false,
	createdAt: 0,
	disabledAt: null,
	lastLoginAt: null
};

function event(user: User | null): RequestEvent {
	return {
		locals: { user },
		params: { id: 'ag_x' },
		url: new URL('http://test/admin/api/agents/ag_x'),
		request: new Request('http://test', { method: 'POST', body: '{}' })
	} as unknown as RequestEvent;
}

// never-typed param accepts any route-specific RequestHandler; the
// fabricated event only needs locals/user for the guard under test.
async function status(fn: (e: never) => unknown, user: User | null): Promise<number> {
	try {
		await fn(event(user) as never);
		return 200;
	} catch (e) {
		const s = (e as { status?: unknown }).status;
		return typeof s === 'number' ? s : 0;
	}
}

const handlers = [
	['list', listAgents],
	['create', createAgent],
	['get', getAgent],
	['patch', patchAgent],
	['delete', deleteAgent],
	['history', getHistory],
	['edge', getEdge],
	['rotate-hub-key', rotateHubKey]
] as const;

// Beszel GHSA-5f5r-95pg-xrpm class: per-resource endpoints must enforce
// the permission model, not bare authentication. Agent reads leak
// recon-grade host data (ports, processes, containers, fingerprints),
// so every verb is gated on agents.manage which operators lack.
describe('agent route authorization', () => {
	it.each(handlers)('%s rejects unauthenticated with 401', async (_name, handler) => {
		expect(await status(handler, null)).toBe(401);
	});

	it.each(handlers)('%s rejects operators with 403', async (_name, handler) => {
		expect(await status(handler, operator)).toBe(403);
	});
});
