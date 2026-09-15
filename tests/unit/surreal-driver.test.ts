import { describe, expect, it } from 'vitest';
import { SurrealDb } from '../../src/lib/server/store/surreal';

const url = process.env.SURREAL_TEST_URL;
const d = url ? describe : describe.skip;

async function open(): Promise<SurrealDb> {
	const db = new SurrealDb({
		url: url!,
		ns: 'test',
		db: 'test',
		user: 'root',
		pass: 'root'
	});
	// force connect + schema
	await db.exec('SELECT 1 FROM hub_keys LIMIT 0');
	// isolate between tests (seq counters emulate AUTOINCREMENT)
	await db.exec(
		'DELETE FROM markers; DELETE FROM hub_keys; DELETE FROM users; DELETE FROM team_members; DELETE FROM push_beats; DELETE FROM seq'
	);
	return db;
}

d('SurrealDb (live)', () => {
	it('runs inserts with seq ids and lastInsertRowid', async () => {
		const db = await open();
		const r = await db
			.prepare('INSERT INTO markers (ts, title, kind) VALUES (?, ?, ?)')
			.run(1, 'a', 'm');
		expect(r.changes).toBe(1);
		expect(r.lastInsertRowid).toBe(1);
		const r2 = await db
			.prepare('INSERT INTO markers (ts, title, kind) VALUES (?, ?, ?)')
			.run(2, 'b', 'm');
		expect(r2.lastInsertRowid).toBe(2);
		const rows = await db.prepare('SELECT * FROM markers ORDER BY id').all();
		expect(rows).toHaveLength(2);
		expect(rows[0].id).toBe(1);
		expect(rows[0].title).toBe('a');
		await db.close();
	});

	it('honors text primary keys and record lookups', async () => {
		const db = await open();
		await db
			.prepare('INSERT INTO hub_keys (id, priv, pub, created_at) VALUES (?, ?, ?, ?)')
			.run(1, 'p', 'q', 5);
		const dup = await db
			.prepare('INSERT OR IGNORE INTO hub_keys (id, priv, pub, created_at) VALUES (?, ?, ?, ?)')
			.run(1, 'x', 'y', 6);
		expect(dup.changes).toBe(0);
		const row = await db.prepare('SELECT pub FROM hub_keys WHERE id = ?').get(1);
		expect(row?.pub).toBe('q');
		await db.close();
	});

	it('reports changes for update and delete', async () => {
		const db = await open();
		await db.prepare('INSERT INTO markers (ts, title, kind) VALUES (?, ?, ?)').run(1, 'a', 'm');
		const upd = await db.prepare('UPDATE markers SET title = ? WHERE id = ?').run('z', 1);
		expect(upd.changes).toBe(1);
		const none = await db.prepare('UPDATE markers SET title = ? WHERE id = ?').run('z', 99);
		expect(none.changes).toBe(0);
		const del = await db.prepare('DELETE FROM markers WHERE id = ?').run(1);
		expect(del.changes).toBe(1);
		await db.close();
	});

	it('applies record-key upserts', async () => {
		const db = await open();
		const sql =
			'INSERT INTO push_beats (service_id, last_beat, beats, last_msg) VALUES (?, ?, 1, ?) ' +
			'ON CONFLICT(service_id) DO UPDATE SET last_beat = excluded.last_beat, beats = beats + 1, last_msg = excluded.last_msg';
		await db.prepare(sql).run('svc1', 100, 'a');
		await db.prepare(sql).run('svc1', 200, 'b');
		const rows = await db.prepare('SELECT * FROM push_beats').all();
		expect(rows).toHaveLength(1);
		expect(rows[0].beats).toBe(2);
		expect(rows[0].last_beat).toBe(200);
		await db.close();
	});

	it('maintains fold shadow cols and rejects non-key upserts', async () => {
		const db = await open();
		await db
			.prepare(
				'INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)'
			)
			.run('Alice', 'Alice', 'h', 'admin', 1);
		const row = await db
			.prepare('SELECT username_lc FROM users WHERE username_lc = ?')
			.get('alice');
		expect(row).toBeDefined();
		expect(() =>
			db.prepare(
				'INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash'
			)
		).toThrow();
		await db.close();
	});

	it('commits and cancels interactive transactions', async () => {
		const db = await open();
		await db.tx(async (tx) => {
			await tx.prepare('INSERT INTO markers (ts, title, kind) VALUES (?, ?, ?)').run(1, 'a', 'm');
		});
		expect(await db.prepare('SELECT * FROM markers').all()).toHaveLength(1);
		await expect(
			db.tx(async (tx) => {
				await tx.prepare('INSERT INTO markers (ts, title, kind) VALUES (?, ?, ?)').run(2, 'b', 'm');
				throw new Error('boom');
			})
		).rejects.toThrow('boom');
		expect(await db.prepare('SELECT * FROM markers').all()).toHaveLength(1);
		await db.close();
	});

	it('synthesizes composite record ids', async () => {
		const db = await open();
		await db.prepare('INSERT INTO team_members (team_id, user_id) VALUES (?, ?)').run('t1', 7);
		const row = await db
			.prepare('SELECT * FROM team_members WHERE team_id = ? AND user_id = ?')
			.get('t1', 7);
		expect(row).toBeDefined();
		expect(row?.user_id).toBe(7);
		const dup = await db
			.prepare('INSERT OR IGNORE INTO team_members (team_id, user_id) VALUES (?, ?)')
			.run('t1', 7);
		expect(dup.changes).toBe(0);
		await db.close();
	});
});
