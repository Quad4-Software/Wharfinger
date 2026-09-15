import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getRuntime } from '$lib/server/runtime';
import { tokenMatches } from '$lib/server/store/push';

// Dead-man's-switch check-in: /api/push/<token>. Cron jobs and
// services hit this on their own schedule; a missed expected interval
// flips the matching service down via the push checker. Tokens are
// derived per service under the hub key and matched in constant time.

const CORS = { 'access-control-allow-origin': '*' };

async function beat(request: Request, token: string) {
	const rt = getRuntime();
	let svc: (typeof rt.config.services)[number] | undefined;
	for (const s of rt.config.services) {
		if (s.type !== 'push') continue;
		if (await tokenMatches(rt.db, s.id, token)) {
			svc = s;
			break;
		}
	}
	if (!svc) return json({ ok: false }, { status: 404, headers: CORS });

	let msg: string | null = request.url.includes('?')
		? new URL(request.url).searchParams.get('msg')
		: null;
	if (msg === null && request.method === 'POST') {
		const ct = request.headers.get('content-type') ?? '';
		if (ct.includes('application/json')) {
			try {
				const body: unknown = await request.json();
				const m =
					body !== null && typeof body === 'object' ? (body as { msg?: unknown }).msg : null;
				if (typeof m === 'string') msg = m;
			} catch {
				// a bad body still counts as a beat
			}
		}
	}
	await rt.pushBeats.beat(svc.id, msg?.slice(0, 200) ?? null);
	return json({ ok: true, at: Date.now() }, { headers: CORS });
}

export const GET: RequestHandler = (e) => beat(e.request, e.params.token);
export const POST: RequestHandler = (e) => beat(e.request, e.params.token);
