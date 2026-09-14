import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { StatusSnapshot } from '../../src/lib/shared/types';

test('page has no detectable a11y violations', async ({ page }) => {
	await page.goto('/');
	// Expand a card so axe sees the collapsible content too.
	await page.getByRole('button', { name: /MeshChatX/ }).click();
	const results = await new AxeBuilder({ page }).analyze();
	const serious = results.violations.filter((v) =>
		['critical', 'serious'].includes(v.impact ?? '')
	);
	expect(serious, JSON.stringify(serious.map((v) => [v.id, v.nodes.length]))).toEqual([]);
});

test('incident rail floats beside content on wide screens, stacks on narrow', async ({ page }) => {
	await page.goto('/');
	const rail = page.getByRole('complementary', { name: 'Incident history' });
	await expect(rail).toBeVisible();

	await page.setViewportSize({ width: 1440, height: 900 });
	await expect(rail).toHaveCSS('position', 'sticky');

	await page.setViewportSize({ width: 640, height: 900 });
	await expect(rail).toHaveCSS('position', 'static');
});

test('no horizontal overflow on narrow and wide viewports', async ({ page }) => {
	for (const width of [320, 640, 1440]) {
		await page.setViewportSize({ width, height: 900 });
		await page.goto('/');
		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		);
		expect(overflow, `viewport ${width}px`).toBeLessThanOrEqual(0);
	}
});

test('uptime bars never overflow their card', async ({ page }) => {
	await page.goto('/');
	const card = page.getByRole('button', { name: /MeshChatX/ });
	const bars = card.locator('[role="listitem"]');
	const cardBox = await card.boundingBox();
	const lastBar = await bars.last().boundingBox();
	const firstBar = await bars.first().boundingBox();
	expect(cardBox).not.toBeNull();
	expect(firstBar!.x).toBeGreaterThanOrEqual(cardBox!.x);
	expect(lastBar!.x + lastBar!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width + 1);
});

test('service cards expand and collapse with the keyboard', async ({ page }) => {
	await page.goto('/');
	const trigger = page.getByRole('button', { name: /MeshChatX/ });
	await trigger.focus();
	await expect(trigger).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(trigger).toHaveAttribute('aria-expanded', 'true');
	await expect(page.locator('[data-state="open"]').getByText('Last checked')).toBeVisible();
	await page.keyboard.press('Enter');
	await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test('skip link reaches main content', async ({ page }) => {
	await page.goto('/');
	await page.keyboard.press('Tab');
	const skip = page.getByRole('link', { name: 'Skip to status' });
	await expect(skip).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(page.locator('#status-content')).toBeInViewport();
});

test('card content truncates instead of overflowing', async ({ page }) => {
	await page.goto('/');
	// Truncated text should be clipped inside the card, never spill out.
	const bad = await page.evaluate(() => {
		const out: string[] = [];
		for (const el of document.querySelectorAll('main button')) {
			if (el.scrollWidth > el.clientWidth + 1) {
				out.push((el.textContent || '').trim().slice(0, 40));
			}
		}
		return out;
	});
	expect(bad).toEqual([]);
});

test('favicon endpoint 404s cleanly for unknown or missing icons', async ({ request }) => {
	expect((await request.get('/favicon/not-a-service')).status()).toBe(404);
	// Valid service ids still 404 when nothing has been cached yet, or 200
	// with an image content type once the fetcher has run.
	const res = await request.get('/favicon/meshchatx');
	expect([200, 404]).toContain(res.status());
	if (res.status() === 200) {
		expect(res.headers()['content-type']).toMatch(/^image\//);
		expect(res.headers()['content-security-policy']).toContain("script-src 'none'");
	}
});

test('uptime tooltip stays inside the viewport on edge bars', async ({ page }) => {
	await page.goto('/');
	const tip = page.getByRole('tooltip');
	const vw = page.viewportSize()!.width;
	for (const pick of ['first', 'last'] as const) {
		const bar = page.locator('[role="listitem"]')[pick]();
		// Hover twice: the first move can land before hydration attaches
		// pointer listeners, so leave and re-enter to be safe.
		await bar.hover();
		await page.mouse.move(0, 0);
		await bar.hover();
		await expect(tip).toBeVisible();
		const box = await tip.boundingBox();
		expect(box, `${pick} bar`).not.toBeNull();
		expect(box!.x).toBeGreaterThanOrEqual(0);
		expect(box!.x + box!.width).toBeLessThanOrEqual(vw);
		await page.mouse.move(0, 0);
	}
});

test('scheduled maintenance section shows the weekly patch window', async ({ page }) => {
	await page.goto('/');
	const section = page.getByRole('region', { name: 'Scheduled maintenance' });
	await expect(section).toBeVisible();
	await expect(section.getByText('Patch Tuesday').first()).toBeVisible();
	await expect(section.getByText(/repeats every Tuesday/).first()).toBeVisible();
});

test('maintenance windows appear in the status API', async ({ request }) => {
	const body = (await (await request.get('/api/status')).json()) as StatusSnapshot;
	expect(body.maintenance.upcoming.length).toBeGreaterThan(0);
	const patch = body.maintenance.upcoming.find((w) => w.title === 'Patch Tuesday');
	expect(patch).toBeDefined();
	expect(patch!.weekly).toBe('tue');
});
