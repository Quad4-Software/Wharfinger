import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IconCache, findIconHrefs } from '$lib/server/icons';
import { makeEgress } from '$lib/server/http/egress';
import type { ServiceConfig } from '$lib/server/config/schema';

const BASE = 'https://example.com/';

describe('findIconHrefs', () => {
	it('extracts absolute and relative icon links', () => {
		const html = `
			<html><head>
			<link rel="icon" type="image/png" href="/favicon-32.png">
			<link rel='shortcut icon' href='https://cdn.example.com/i.ico'>
			<link rel="stylesheet" href="/app.css">
			</head></html>`;
		const hrefs = findIconHrefs(html, BASE);
		expect(hrefs).toContain('https://example.com/favicon-32.png');
		expect(hrefs).toContain('https://cdn.example.com/i.ico');
		expect(hrefs).not.toContain('https://example.com/app.css');
	});

	it('rejects non-http schemes and junk', () => {
		const html = `
			<link rel="icon" href="data:image/svg+xml,<svg/>">
			<link rel="icon" href="javascript:alert(1)">
			<link rel="icon" href="//:bad">
		`;
		expect(findIconHrefs(html, BASE)).toEqual([]);
	});

	it('prefers nothing when no icons exist', () => {
		expect(findIconHrefs('<html><head></head></html>', BASE)).toEqual([]);
	});
});

describe('IconCache egress guard', () => {
	it('never fetches icons from link-local or metadata targets', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'wharfinger-icons-'));
		const cache = new IconCache(
			dir,
			'test-agent',
			makeEgress(() => false)
		);
		const svc = {
			id: 'meta',
			name: 'Meta',
			type: 'http',
			url: 'http://169.254.169.254/latest/meta-data'
		} as ServiceConfig;
		cache.schedule([svc]);
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		cache.stop();
		expect(cache.has('meta')).toBe(false);
	});

	it('refuses when the page points the icon link at a blocked host', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'wharfinger-icons-'));
		const cache = new IconCache(
			dir,
			'test-agent',
			makeEgress(() => false)
		);
		const svc = {
			id: 'host',
			name: 'Host',
			type: 'http',
			url: 'http://[fd00:ec2::254]/'
		} as ServiceConfig;
		cache.schedule([svc]);
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		cache.stop();
		expect(cache.has('host')).toBe(false);
	});
});
