// Quick web-vitals probe against the dev server. Usage:
//   node scripts/vitals.mjs [baseUrl]
// Prints FCP, LCP, CLS, TTFB, and JS heap per page.
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://localhost:5173';
const pages = process.argv[3]
	? process.argv[3].split(',')
	: ['/', '/admin', '/admin/services', '/admin/pages', '/admin/chat', '/admin/audit'];

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

// Log in once so admin routes render the real panel.
await page.goto(`${base}/admin/login`);
const userInput = page.locator(
	'input[name="username"], input#username, input[autocomplete="username"]'
);
if (await userInput.count()) {
	await userInput.fill('admin');
	await page.locator('input[type="password"]').fill('wharfinger-local-2026');
	await page.locator('button[type="submit"], button:has-text("Sign in")').first().click();
	await page.waitForURL(/admin/, { timeout: 10_000 }).catch(() => {});
}

for (const path of pages) {
	await page.addInitScript(() => {
		window.__vitals = { fcp: 0, lcp: 0, cls: 0 };
		new PerformanceObserver((list) => {
			for (const e of list.getEntries())
				if (e.name === 'first-contentful-paint') window.__vitals.fcp = e.startTime;
		}).observe({ type: 'paint', buffered: true });
		new PerformanceObserver((list) => {
			for (const e of list.getEntries()) window.__vitals.lcp = e.startTime;
		}).observe({ type: 'largest-contentful-paint', buffered: true });
		new PerformanceObserver((list) => {
			for (const e of list.getEntries()) if (!e.hadRecentInput) window.__vitals.cls += e.value;
		}).observe({ type: 'layout-shift', buffered: true });
	});
	const t0 = Date.now();
	const res = await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
	await page.waitForTimeout(1500);
	const nav = await page.evaluate(() => {
		const n = performance.getEntriesByType('navigation')[0];
		return { ttfb: n?.responseStart ?? 0, heap: performance.memory?.usedJSHeapSize ?? 0 };
	});
	const v = await page.evaluate(() => window.__vitals);
	console.log(
		`${path.padEnd(20)} status=${res?.status()} ttfb=${nav.ttfb.toFixed(0)}ms ` +
			`wall=${Date.now() - t0}ms fcp=${v.fcp.toFixed(0)}ms lcp=${v.lcp.toFixed(0)}ms ` +
			`cls=${v.cls.toFixed(3)} heap=${(nav.heap / 1048576).toFixed(1)}MB`
	);
}

await browser.close();
