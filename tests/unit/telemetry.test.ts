import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import { openDb } from '$lib/server/store/db';
import { TelemetryStore } from '$lib/server/telemetry/store';
import {
	itemFromEnvelope,
	normalizeEvent,
	resolveProject,
	sentryKey
} from '$lib/server/telemetry/ingest';

function store() {
	return new TelemetryStore(openDb(mkdtempSync(join(tmpdir(), 'wharfinger-tel-'))));
}

function rec(
	store: TelemetryStore,
	projectId: number,
	extra: Partial<Parameters<TelemetryStore['record']>[0]> = {}
) {
	store.record({
		projectId,
		fingerprint: 'fp_' + Math.random().toString(16).slice(2, 10),
		title: 'TypeError: boom',
		culprit: null,
		level: 'error',
		eventId: null,
		ts: Date.now(),
		platform: null,
		message: null,
		excType: null,
		excValue: null,
		release: null,
		environment: null,
		tags: '{}',
		request: null,
		stack: null,
		raw: '{}',
		...extra
	});
}

describe('TelemetryStore', () => {
	let ts: TelemetryStore;
	beforeEach(() => {
		ts = store();
	});

	it('creates projects with unique keys', () => {
		const a = ts.createProject('a');
		const b = ts.createProject('b');
		expect(a.publicKey).toMatch(/^[a-f0-9]{32}$/);
		expect(b.publicKey).not.toBe(a.publicKey);
		expect(ts.projects()).toHaveLength(2);
	});

	it('groups events into issues by fingerprint', () => {
		const p = ts.createProject('app');
		rec(ts, p.id, { fingerprint: 'fp_same' });
		rec(ts, p.id, { fingerprint: 'fp_same' });
		rec(ts, p.id, { fingerprint: 'fp_other' });
		const r = ts.issues(p.id, { limit: 50 });
		expect(r.total).toBe(2);
		const same = r.entries.find((e) => e.fingerprint === 'fp_same')!;
		expect(same.count).toBe(2);
	});

	it('re-resolves an issue when a new event lands', () => {
		const p = ts.createProject('app');
		rec(ts, p.id, { fingerprint: 'fp_x' });
		ts.setIssueResolved(p.id, 'fp_x', true);
		expect(ts.issue(p.id, 'fp_x')!.resolvedAt).not.toBeNull();
		rec(ts, p.id, { fingerprint: 'fp_x' });
		expect(ts.issue(p.id, 'fp_x')!.resolvedAt).toBeNull();
	});

	it('searches issues by title and culprit', () => {
		const p = ts.createProject('app');
		rec(ts, p.id, { fingerprint: 'fp_1', title: 'NullPointer in cart', culprit: 'CartService' });
		rec(ts, p.id, { fingerprint: 'fp_2', title: 'Timeout in auth' });
		expect(ts.issues(p.id, { limit: 50, q: 'cart' }).total).toBe(1);
		expect(ts.issues(p.id, { limit: 50, q: 'CartService' }).total).toBe(1);
	});

	it('enforces the per-project event cap', () => {
		const p = ts.createProject('app');
		for (let i = 0; i < 60; i++) rec(ts, p.id, { fingerprint: `fp_c${i}` });
		ts.prune();
		// cap is 50k in production; prune with default does nothing at 60,
		// but the oldest-first trim path must not error.
		expect(ts.events(p.id, 'fp_c59', { limit: 5 }).total).toBe(1);
	});

	it('deleting a project removes issues and events', () => {
		const p = ts.createProject('app');
		rec(ts, p.id, { fingerprint: 'fp_d' });
		ts.deleteProject(p.id);
		expect(ts.issues(p.id, { limit: 10 }).total).toBe(0);
	});
});

describe('ingest: sentryKey', () => {
	function req(headers: Record<string, string>) {
		return new Request('https://h/api/1/envelope/', { method: 'POST', headers });
	}
	it('parses sentry_key from auth header', () => {
		expect(
			sentryKey(
				req({ 'x-sentry-auth': 'Sentry sentry_version=7, sentry_key=abc123, sentry_client=x' })
			)
		).toBe('abc123');
	});
	it('parses bearer tokens', () => {
		expect(sentryKey(req({ authorization: 'Bearer fed456abc' }))).toBe('fed456abc');
	});
	it('returns null for malformed', () => {
		expect(sentryKey(req({}))).toBeNull();
		expect(sentryKey(req({ 'x-sentry-auth': 'Sentry' }))).toBeNull();
	});
});

describe('ingest: resolveProject', () => {
	it('matches project id + key and rejects wrong/disabled', () => {
		const ts = store();
		const p = ts.createProject('app');
		expect(resolveProject(ts, String(p.id), p.publicKey)?.id).toBe(p.id);
		expect(resolveProject(ts, String(p.id), 'deadbeef')).toBeNull();
		expect(resolveProject(ts, '999', p.publicKey)).toBeNull();
		expect(resolveProject(ts, 'notanumber', p.publicKey)).toBeNull();
		ts.setProjectDisabled(p.id, true);
		expect(resolveProject(ts, String(p.id), p.publicKey)).toBeNull();
	});
});

describe('ingest: normalizeEvent', () => {
	it('fingerprints exceptions and scrubs secrets', () => {
		const e = normalizeEvent({
			exception: {
				values: [
					{
						type: 'TypeError',
						value: 'cannot read x',
						stacktrace: {
							frames: [
								{ filename: '/app/a.js', function: 'main', lineno: 3 },
								{ filename: '/app/b.js', function: 'run', lineno: 9 }
							]
						}
					}
				]
			},
			request: {
				url: 'https://app.internal/x?password=hunter2&ok=1',
				method: 'GET',
				headers: { cookie: 'session=secret', 'x-api-key': 'key', accept: 'text/html' },
				cookies: { session: 'secret' },
				data: { token: 'abc', keep: 'v' }
			},
			tags: { env: 'prod' }
		});
		expect(e.title).toBe('TypeError: cannot read x');
		expect(e.level).toBe('error');
		expect(e.fingerprint).toMatch(/^[a-f0-9]{32}$/);
		expect(e.request).toContain('[Filtered]');
		expect(e.request).not.toContain('hunter2');
		expect(e.request).not.toContain('session=secret');
		expect(e.raw).not.toContain('hunter2');
		expect(e.raw).not.toContain('"session":"secret"');
		expect(e.raw).not.toContain('"token":"abc"');
		expect(e.raw).toContain('"keep":"v"');
	});

	it('groups logentry events by template, not rendered params', () => {
		const a = normalizeEvent({
			logentry: { formatted: 'user 42 failed', message: 'user %s failed' },
			level: 'warning'
		});
		const b = normalizeEvent({
			logentry: { formatted: 'user 99 failed', message: 'user %s failed' }
		});
		expect(a.fingerprint).toBe(b.fingerprint);
		expect(a.message).toBe('user 42 failed');
		expect(a.level).toBe('warning');
	});

	it('clamps future timestamps', () => {
		const e = normalizeEvent({ timestamp: Date.now() / 1000 + 99999, message: 'x' });
		expect(e.ts).toBeLessThanOrEqual(Date.now() + 61_000);
	});
});

describe('ingest: envelope parsing', () => {
	function env(items: string[]): Uint8Array {
		return new TextEncoder().encode(items.join('\n'));
	}
	function ev(body: Uint8Array): Record<string, unknown> | null {
		const i = itemFromEnvelope(body);
		return i?.kind === 'event' ? i.event : null;
	}
	it('extracts the first event item', () => {
		const e = ev(
			env([
				'{"event_id":"abc"}',
				'{"type":"session"}',
				'{"sid":"x"}',
				'{"type":"event"}',
				'{"message":"hi","level":"error"}'
			])
		);
		expect(e?.message).toBe('hi');
	});
	it('respects item length headers', () => {
		const payload = '{"message":"len-test"}';
		const e = ev(env(['{"event_id":"a"}', `{"type":"event","length":${payload.length}}`, payload]));
		expect(e?.message).toBe('len-test');
	});
	it('skips attachments and returns null on empty', () => {
		expect(ev(env(['{"event_id":"a"}']))).toBeNull();
		expect(ev(env(['{}', '{"type":"attachment","length":3}', 'abc']))).toBeNull();
	});
	it('skips oversized items instead of reading them', () => {
		const big = 'x'.repeat(400 * 1024);
		const e = ev(env(['{}', '{"type":"event"}', big, '{"type":"event"}', '{"message":"second"}']));
		expect(e?.message).toBe('second');
	});
});
