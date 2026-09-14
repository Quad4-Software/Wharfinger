import { expect, test } from '@playwright/test';
import type { StatusSnapshot } from '../../src/lib/shared/types';

test('status page renders overall banner and groups', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	await expect(page.getByText('Quad4 Software', { exact: true })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Chat', exact: true })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'MeshChatX', exact: true })).toBeVisible();
});

test('status API returns a snapshot', async ({ request }) => {
	const res = await request.get('/api/status');
	expect(res.ok()).toBe(true);
	const body = (await res.json()) as StatusSnapshot;
	expect(body.site.name).toBe('Quad4 Software');
	expect(body.groups.length).toBeGreaterThan(0);
});

test('named page at /p/projects shows only its services', async ({ page }) => {
	await page.goto('/p/projects');
	await expect(page.getByRole('heading', { name: 'MeshChatX', exact: true })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'LXMFy', exact: true })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Chat', exact: true })).toBeHidden();
});

test('unknown named page returns 404', async ({ request }) => {
	const res = await request.get('/p/does-not-exist');
	expect(res.status()).toBe(404);
});

test('header links to configured pages', async ({ page }) => {
	await page.goto('/');
	const nav = page.getByRole('navigation');
	await expect(nav.getByRole('link', { name: 'All', exact: true })).toBeVisible();
	await expect(nav.getByRole('link', { name: 'Projects', exact: true })).toBeVisible();
});

test('healthz responds', async ({ request }) => {
	const res = await request.get('/healthz');
	expect(res.ok()).toBe(true);
	const body = (await res.json()) as { ok: boolean };
	expect(body.ok).toBe(true);
});
