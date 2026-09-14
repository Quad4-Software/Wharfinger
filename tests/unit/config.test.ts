import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, interpolateEnv, loadConfig } from '$lib/server/config/load';

const MINIMAL = `
[site]
name = "Test Co"

[[services]]
id = "web"
name = "Web"
type = "http"
url = "https://example.com"
`;

function writeToml(toml: string): string {
	const dir = mkdtempSync(join(tmpdir(), 'wharfinger-cfg-'));
	const p = join(dir, 'wharfinger.toml');
	writeFileSync(p, toml);
	return p;
}

describe('loadConfig', () => {
	it('parses a minimal config and applies defaults', () => {
		const cfg = loadConfig(writeToml(MINIMAL));
		expect(cfg.site.name).toBe('Test Co');
		expect(cfg.site.title).toBeUndefined();
		expect(cfg.page.refresh_seconds).toBe(30);
		expect(cfg.page.history_days).toBe(90);
		expect(cfg.monitor.failure_threshold).toBe(2);
		expect(cfg.services[0].group).toBe('General');
		expect(cfg.services[0].type).toBe('http');
	});

	it('rejects duplicate service ids', () => {
		const toml = `${MINIMAL}\n[[services]]\nid="web"\nname="dupe"\ntype="tcp"\nhost="x"\nport=443\n`;
		expect(() => loadConfig(writeToml(toml))).toThrow(ConfigError);
	});

	it('rejects invalid service ids', () => {
		const toml = MINIMAL.replace('id = "web"', 'id = "Bad ID!"');
		expect(() => loadConfig(writeToml(toml))).toThrow(ConfigError);
	});

	it('requires at least one service', () => {
		expect(() => loadConfig(writeToml('[site]\nname="x"\n'))).toThrow(ConfigError);
	});

	it('expands env vars with defaults', () => {
		process.env.TEST_Q4_TOKEN = 'secret123';
		const toml = MINIMAL.replace(
			'url = "https://example.com"',
			'url = "https://example.com"\nheaders = { Authorization = "Bearer ${TEST_Q4_TOKEN}", X = "${TEST_MISSING:-fb}" }'
		);
		const cfg = loadConfig(writeToml(toml));
		const svc = cfg.services[0];
		if (svc.type !== 'http') throw new Error('expected http');
		expect(svc.headers?.Authorization).toBe('Bearer secret123');
		expect(svc.headers?.X).toBe('fb');
	});

	it('fails when an env var has no default', () => {
		const toml = MINIMAL.replace('https://example.com', 'https://${Q4_NOPE_HOST}.example.com');
		expect(() => loadConfig(writeToml(toml))).toThrow(/Q4_NOPE_HOST/);
	});

	it('rejects invalid maintenance windows', () => {
		const toml = `${MINIMAL}\n[[maintenance]]\ntitle="m"\nservices=["web"]\nstart="soon"\nend="later"\n`;
		expect(() => loadConfig(writeToml(toml))).toThrow(ConfigError);
	});

	it('rejects maintenance ending before it starts', () => {
		const toml = `${MINIMAL}\n[[maintenance]]\ntitle="m"\nservices=["web"]\nstart="2026-09-20T04:00:00Z"\nend="2026-09-20T02:00:00Z"\n`;
		expect(() => loadConfig(writeToml(toml))).toThrow(ConfigError);
	});

	it('accepts recurring weekly maintenance', () => {
		const toml = `${MINIMAL}\n[[maintenance]]\ntitle="Patch Tuesday"\nservices=["all"]\nweekly="tue"\nat="02:00"\nduration_minutes=120\n`;
		const cfg = loadConfig(writeToml(toml));
		expect(cfg.maintenance[0].weekly).toBe('tue');
		expect(cfg.maintenance[0].duration_minutes).toBe(120);
	});

	it('rejects weekly maintenance missing at or duration', () => {
		const toml = `${MINIMAL}\n[[maintenance]]\ntitle="m"\nservices=["all"]\nweekly="tue"\n`;
		expect(() => loadConfig(writeToml(toml))).toThrow(ConfigError);
	});

	it('rejects non-http URLs that could become XSS vectors', () => {
		const toml = `${MINIMAL}\n[[links]]\nlabel="x"\nhref="javascript:alert(1)"\n`;
		expect(() => loadConfig(writeToml(toml))).toThrow(ConfigError);
	});

	it('accepts a page referencing defined services', () => {
		const toml = `${MINIMAL}\n[[pages]]\nslug="web-only"\ntitle="Web"\nservices=["web"]\n`;
		const cfg = loadConfig(writeToml(toml));
		expect(cfg.pages[0].slug).toBe('web-only');
	});

	it('rejects a page referencing an unknown service', () => {
		const toml = `${MINIMAL}\n[[pages]]\nslug="p1"\ntitle="P1"\nservices=["nope"]\n`;
		expect(() => loadConfig(writeToml(toml))).toThrow(ConfigError);
	});

	it('rejects duplicate page slugs', () => {
		const toml = `${MINIMAL}\n[[pages]]\nslug="p1"\ntitle="P1"\nservices=["all"]\n[[pages]]\nslug="p1"\ntitle="dupe"\nservices=["all"]\n`;
		expect(() => loadConfig(writeToml(toml))).toThrow(ConfigError);
	});

	it('rejects invalid page slugs', () => {
		const toml = `${MINIMAL}\n[[pages]]\nslug="Bad Slug"\ntitle="P"\nservices=["all"]\n`;
		expect(() => loadConfig(writeToml(toml))).toThrow(ConfigError);
	});
});

describe('interpolateEnv', () => {
	it('leaves non-strings untouched', () => {
		expect(interpolateEnv({ a: 1, b: [true] })).toEqual({ a: 1, b: [true] });
	});
});
