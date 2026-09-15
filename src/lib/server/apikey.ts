import type { Runtime } from './runtime';
import type { ApiKey, ApiScope } from './store/apikeys';

// Bearer-key auth for the public automation API under /api/v1.
// Keys carry read and/or write scopes; every resolution is a hash
// lookup, never a token comparison in the clear.

const UNAUTHORIZED = () => Response.json({ error: 'valid api key required' }, { status: 401 });
const FORBIDDEN = () => Response.json({ error: 'key lacks the required scope' }, { status: 403 });

export async function apiKeyOrResponse(
	rt: Runtime,
	request: Request,
	scope: ApiScope
): Promise<{ key: ApiKey } | { res: Response }> {
	const hdr = request.headers.get('authorization') ?? '';
	const token = /^bearer\s+(qs_[0-9a-f]{48})$/i.exec(hdr.trim())?.[1] ?? null;
	if (!token) return { res: UNAUTHORIZED() };
	const key = await rt.apiKeys.resolve(token);
	if (!key) return { res: UNAUTHORIZED() };
	if (!key.scopes.includes(scope)) return { res: FORBIDDEN() };
	await rt.apiKeys.touch(key.id);
	return { key };
}
