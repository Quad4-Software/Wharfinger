import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '$lib/server/store/db';
import { ConfigStore } from '$lib/server/config/store';
import {
	planSectionSave,
	resolveEffective,
	sectionsEqual,
	validateMerged
} from '$lib/server/config/effective';
import { ConfigError, loadRawConfig } from '$lib/server/config/load';

const MINIMAL = `
[site]
name = "Test Co"

[[services]]
id = "web"
name = "Web"
type = "http"
url = "https://example.com"
`;

function freshDb(): DatabaseSync {
	return openDb(mkdtempSync(join(tmpdir(), 'wharfinger-cfgdb-')));
}

function rawOf(toml = MINIMAL): Record<string, unknown> {
	const dir = mkdtempSync(join(tmpdir(), 'wharfinger-cfg-'));
	const p = join(dir, 'wharfinger.toml');
	writeFileSync(p, toml);
	return loadRawConfig(p);
}

describe('ConfigStore', () => {
	it('round-trips section overrides with metadata', () => {
		const store = new ConfigStore(freshDb());
		expect(store.all()).toHaveLength(0);
		store.set('site', { name: 'Override Co' }, 'alice', 1000);
		const o = store.get('site');
		expect(o?.raw).toEqual({ name: 'Override Co' });
		expect(o?.updatedBy).toBe('alice');
		expect(o?.updatedAt).toBe(1000);
		expect(store.all()).toHaveLength(1);
	});

	it('preserves unresolved env placeholders in stored raw values', () => {
		const store = new ConfigStore(freshDb());
		store.set(
			'services',
			[{ id: 'x', name: 'X', type: 'http', url: '${API_URL:-https://a.b}' }],
			null
		);
		const o = store.get('services') as { raw: { url: string }[] } | null;
		expect(o?.raw[0].url).toBe('${API_URL:-https://a.b}');
	});

	it('clears single sections and all sections', () => {
		const store = new ConfigStore(freshDb());
		store.set('site', {}, null);
		store.set('links', [], null);
		store.clear('site');
		expect(store.get('site')).toBeNull();
		expect(store.get('links')).not.toBeNull();
		store.clearAll();
		expect(store.all()).toHaveLength(0);
	});
});

describe('sectionsEqual', () => {
	it('ignores object key order', () => {
		expect(sectionsEqual({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(true);
		expect(sectionsEqual({ a: 1 }, { a: 2 })).toBe(false);
	});
});

describe('resolveEffective', () => {
	it('returns the file config untouched when no overrides exist', () => {
		const eff = resolveEffective(rawOf(), new ConfigStore(freshDb()));
		expect(eff.config.site.name).toBe('Test Co');
		expect(eff.overrides.size).toBe(0);
	});

	it('merges a section override over the file base', () => {
		const store = new ConfigStore(freshDb());
		store.set('site', { name: 'Runtime Co', description: 'live' }, 'alice');
		const eff = resolveEffective(rawOf(), store);
		expect(eff.config.site.name).toBe('Runtime Co');
		expect(eff.config.site.description).toBe('live');
		// other sections still come from the file
		expect(eff.config.services).toHaveLength(1);
	});

	it('replaces whole sections, including explicit empty overrides', () => {
		const fileRaw = rawOf(
			`${MINIMAL}\n[[links]]\nlabel = "Docs"\nurl = "https://docs.example.com"\n`
		);
		const store = new ConfigStore(freshDb());
		store.set('links', [], 'alice');
		const eff = resolveEffective(fileRaw, store);
		expect(eff.config.links).toHaveLength(0);
		// services still come from the file
		expect(eff.config.services).toHaveLength(1);
	});

	it('throws ConfigError when merged config is invalid', () => {
		const store = new ConfigStore(freshDb());
		store.set('site', { name: 42 }, 'alice');
		expect(() => resolveEffective(rawOf(), store)).toThrow(ConfigError);
	});
});

describe('planSectionSave', () => {
	it('is a noop when the value matches the file and no override exists', () => {
		const fileRaw = rawOf();
		expect(planSectionSave(fileRaw, new Map(), 'site', fileRaw.site)).toBe('noop');
	});

	it('stores when the value differs from the file', () => {
		const fileRaw = rawOf();
		expect(planSectionSave(fileRaw, new Map(), 'site', { name: 'Other' })).toBe('store');
	});

	it('clears when the value returns to the file value', () => {
		const fileRaw = rawOf();
		const overrides = new Map([
			['site', { section: 'site', raw: { name: 'X' }, updatedBy: null, updatedAt: 1 }]
		]);
		expect(planSectionSave(fileRaw, overrides, 'site', fileRaw.site)).toBe('clear');
	});
});

describe('validateMerged', () => {
	it('validates a candidate section against the merged document', () => {
		const fileRaw = rawOf();
		const ok = validateMerged(fileRaw, new Map(), 'site', { name: 'New Name' });
		expect(ok.site.name).toBe('New Name');
	});

	it('rejects cross-section violations', () => {
		const fileRaw = rawOf();
		expect(() =>
			validateMerged(fileRaw, new Map(), 'pages', [
				{ slug: 'dash', title: 'Dash', services: ['missing'] }
			])
		).toThrow(ConfigError);
	});

	it('validates removal of a section against remaining overrides', () => {
		const fileRaw = rawOf();
		const overrides = new Map([
			[
				'pages',
				{
					section: 'pages',
					raw: [{ slug: 'dash', title: 'Dash', services: ['web'] }],
					updatedBy: null,
					updatedAt: 1
				}
			]
		]);
		// removing services breaks the pages override that references web
		expect(() => validateMerged(fileRaw, overrides, 'services', undefined)).toThrow(ConfigError);
	});
});
