import { expect, test } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';

// Telemetry ingest e2e: a project is seeded straight into the e2e
// database, then Sentry-protocol envelopes land through the public
// endpoint and group into issues.

const DB = 'test-results/e2e-data/wharfinger.db';
const KEY = 'e2e0123456789abcdef0123456789ab';
let projectId = 0;

function open(): DatabaseSync {
	const db = new DatabaseSync(DB);
	db.exec('PRAGMA busy_timeout = 10000;');
	return db;
}

test.beforeAll(() => {
	const db = open();
	db.exec("DELETE FROM telemetry_projects WHERE public_key = '" + KEY + "'");
	const r = db
		.prepare(
			'INSERT INTO telemetry_projects (name, public_key, platform, created_at) VALUES (?, ?, ?, ?)'
		)
		.run('e2e-app', KEY, 'node', Date.now());
	projectId = Number(r.lastInsertRowid);
	db.close();
});

function envelope(event: Record<string, unknown>): string {
	const payload = JSON.stringify(event);
	const id = typeof event.event_id === 'string' ? event.event_id : 'e1';
	return `{"event_id":"${id}"}\n{"type":"event","length":${payload.length}}\n${payload}`;
}

const AUTH = { 'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${KEY}` };

// The seeded project is shared; parallel workers would delete each other's rows.
test.describe.configure({ mode: 'serial' });

test('envelope ingest stores and groups events', async ({ request }) => {
	const mk = (value: string) => ({
		exception: { values: [{ type: 'E2EError', value }] },
		level: 'error',
		platform: 'node',
		event_id: `e2e-${value}`
	});
	for (const v of ['one', 'two']) {
		const res = await request.post(`/api/${projectId}/envelope/`, {
			headers: { ...AUTH, 'content-type': 'application/x-sentry-envelope' },
			data: envelope(mk(v))
		});
		expect(res.status()).toBe(200);
	}
	const db = open();
	const issue = db
		.prepare('SELECT count FROM telemetry_issues WHERE project_id = ?')
		.get(projectId) as { count: number };
	expect(issue.count).toBe(2);
	const ev = db
		.prepare('SELECT exc_type AS t FROM telemetry_events WHERE project_id = ?')
		.get(projectId) as { t: string };
	expect(ev.t).toBe('E2EError');
	db.close();
});

test('store endpoint accepts legacy event json', async ({ request }) => {
	const res = await request.post(`/api/${projectId}/store/`, {
		headers: { ...AUTH, 'content-type': 'application/json' },
		data: { message: 'legacy store hit', level: 'warning' }
	});
	expect(res.status()).toBe(200);
});

test('wrong key, wrong project, disabled project all rejected', async ({ request }) => {
	const body = envelope({ message: 'nope' });
	const headers = { 'content-type': 'application/x-sentry-envelope' };
	expect(
		(
			await request.post(`/api/${projectId}/envelope/`, {
				headers: { ...headers, 'x-sentry-auth': 'Sentry sentry_key=deadbeef' },
				data: body
			})
		).status()
	).toBe(401);
	expect(
		(
			await request.post('/api/99999/envelope/', { headers: { ...headers, ...AUTH }, data: body })
		).status()
	).toBe(401);
	expect(
		(await request.post(`/api/${projectId}/envelope/`, { headers, data: body })).status()
	).toBe(401);

	const db = open();
	db.prepare('UPDATE telemetry_projects SET disabled_at = ? WHERE id = ?').run(
		Date.now(),
		projectId
	);
	db.close();
	expect(
		(
			await request.post(`/api/${projectId}/envelope/`, {
				headers: { ...headers, ...AUTH },
				data: body
			})
		).status()
	).toBe(401);
	dbReenable();
});

function dbReenable(): void {
	const db = open();
	db.prepare('UPDATE telemetry_projects SET disabled_at = NULL WHERE id = ?').run(projectId);
	db.close();
}

test('scrubbed secrets never persist', async ({ request }) => {
	const res = await request.post(`/api/${projectId}/store/`, {
		headers: { ...AUTH, 'content-type': 'application/json' },
		data: {
			message: 'scrub-me',
			request: {
				url: 'https://app/x?password=hunter2',
				headers: { cookie: 'session=abc', accept: 'text/html' }
			}
		}
	});
	expect(res.status()).toBe(200);
	const db = open();
	const row = db
		.prepare("SELECT raw FROM telemetry_events WHERE project_id = ? AND message = 'scrub-me'")
		.get(projectId) as { raw: string };
	expect(row.raw).not.toContain('hunter2');
	expect(row.raw).not.toContain('session=abc');
	db.close();
});

test('transaction envelope stores a trace, not an issue', async ({ request }) => {
	const traceId = 'e2e0123456789abcdef0123456789abc';
	const tx = {
		type: 'transaction',
		transaction: 'GET /e2e',
		start_timestamp: 1700000000,
		timestamp: 1700000000.4,
		contexts: {
			trace: { trace_id: traceId, span_id: 'e2e0123456789abc', op: 'http.server', status: 'ok' }
		},
		spans: [
			{
				span_id: 'e2e0123456789abd',
				parent_span_id: 'e2e0123456789abc',
				op: 'db',
				description: 'SELECT 1',
				start_timestamp: 1700000000.1,
				timestamp: 1700000000.2
			}
		]
	};
	const payload = JSON.stringify(tx);
	const before = open();
	const issuesBefore = (
		before
			.prepare('SELECT COUNT(*) AS n FROM telemetry_issues WHERE project_id = ?')
			.get(projectId) as { n: number }
	).n;
	before.close();
	const res = await request.post(`/api/${projectId}/envelope/`, {
		headers: { ...AUTH, 'content-type': 'application/x-sentry-envelope' },
		data: `{"event_id":"t1"}\n{"type":"transaction","length":${payload.length}}\n${payload}`
	});
	expect(res.status()).toBe(200);
	const db = open();
	const trace = db
		.prepare('SELECT name, duration_ms, span_count FROM telemetry_traces WHERE trace_id = ?')
		.get(traceId) as { name: string; duration_ms: number; span_count: number };
	expect(trace.name).toBe('GET /e2e');
	expect(trace.duration_ms).toBe(400);
	expect(trace.span_count).toBe(1);
	const span = db
		.prepare(
			'SELECT op FROM telemetry_spans WHERE trace_row_id = (SELECT id FROM telemetry_traces WHERE trace_id = ?)'
		)
		.get(traceId) as { op: string };
	expect(span.op).toBe('db');
	const issuesAfter = (
		db
			.prepare('SELECT COUNT(*) AS n FROM telemetry_issues WHERE project_id = ?')
			.get(projectId) as {
			n: number;
		}
	).n;
	expect(issuesAfter).toBe(issuesBefore);
	db.close();
});

test('oversized envelope rejected', async ({ request }) => {
	const res = await request.post(`/api/${projectId}/envelope/`, {
		headers: { ...AUTH, 'content-type': 'application/x-sentry-envelope' },
		data: 'x'.repeat(1024 * 1024 + 10)
	});
	expect(res.status()).toBe(413);
});
