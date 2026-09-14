import { expect, request as pwRequest, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';

// OIDC e2e: a mock provider serves discovery, authorize, token, and
// userinfo endpoints; the hub's oidc section is enabled through the
// real admin sections API so the full merged-config pipeline runs.

const MOCK_PORT = 4195;
const ISSUER = `http://127.0.0.1:${MOCK_PORT}`;
const ADMIN = { username: 'e2e-admin', password: 'e2e-local-secret-99' };

// Claims the mock userinfo endpoint returns; tests mutate per case.
let claims: Record<string, unknown> = {
	sub: 'sso-1',
	preferred_username: 'ssoalice',
	name: 'Alice SSO',
	groups: ['admins']
};

let mock: Server;

// The config override is shared hub state; keep this file serial.
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
	mock = createServer((req, res) => {
		const url = new URL(req.url ?? '/', ISSUER);
		if (url.pathname === '/.well-known/openid-configuration') {
			res.setHeader('content-type', 'application/json');
			res.end(
				JSON.stringify({
					issuer: ISSUER,
					authorization_endpoint: `${ISSUER}/authorize`,
					token_endpoint: `${ISSUER}/token`,
					userinfo_endpoint: `${ISSUER}/userinfo`
				})
			);
			return;
		}
		if (url.pathname === '/authorize') {
			const back = new URL(url.searchParams.get('redirect_uri') ?? '');
			back.searchParams.set('code', 'mock-code');
			back.searchParams.set('state', url.searchParams.get('state') ?? '');
			res.writeHead(302, { location: back.toString() }).end();
			return;
		}
		if (url.pathname === '/token') {
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ access_token: 'mock-at', token_type: 'Bearer' }));
			return;
		}
		if (url.pathname === '/userinfo') {
			if (req.headers.authorization !== 'Bearer mock-at') {
				res.writeHead(401).end();
				return;
			}
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify(claims));
			return;
		}
		res.writeHead(404).end();
	});
	await new Promise<void>((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

	// Enable the oidc section through the real admin API.
	const ctx = await pwRequest.newContext({ baseURL: 'http://127.0.0.1:4173' });
	const login = await ctx.post('/admin/api/auth/login', { data: ADMIN });
	expect(login.status()).toBe(200);
	const put = await ctx.put('/admin/api/sections/oidc', {
		data: {
			value: {
				enabled: true,
				issuer: ISSUER,
				client_id: 'e2e-client',
				admin_group: 'admins',
				default_role: 'deny',
				button_label: 'Sign in with SSO'
			}
		}
	});
	expect(put.status()).toBe(200);
	await ctx.dispose();
});

test.afterAll(async () => {
	const ctx = await pwRequest.newContext({ baseURL: 'http://127.0.0.1:4173' });
	await ctx.post('/admin/api/auth/login', { data: ADMIN });
	await ctx.delete('/admin/api/sections/oidc');
	await ctx.dispose();
	await new Promise<void>((r) => {
		mock.close(() => {
			r();
		});
	});
});

test('login page offers SSO and the full flow lands on the panel', async ({ page }) => {
	claims = {
		sub: 'sso-1',
		preferred_username: 'ssoalice',
		name: 'Alice SSO',
		groups: ['admins']
	};
	await page.goto('/admin/login');
	const sso = page.getByRole('link', { name: 'Sign in with SSO' });
	await expect(sso).toBeVisible();
	await sso.click();
	// start -> mock authorize -> callback -> session -> /admin
	await page.waitForURL(/\/admin\/?$/, { timeout: 10_000 });
	await expect(page.locator('body')).not.toContainText('Sign in');
});

test('users without a mapped group are denied', async ({ page }) => {
	claims = { sub: 'sso-2', preferred_username: 'ssobob', groups: ['users'] };
	await page.goto('/admin/api/auth/oidc/start');
	await page.waitForURL(/error=oidc_denied/, { timeout: 10_000 });
});

test('mismatched state is rejected', async ({ page }) => {
	await page.goto('/admin/api/auth/oidc/callback?code=x&state=bogus');
	await page.waitForURL(/error=oidc_state/, { timeout: 10_000 });
});
