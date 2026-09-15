import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { asBytes } from '$lib/server/bytes';
import { asDb, isUniqueViolation, rawSqlite, SqliteDb } from '$lib/server/store/driver';

function freshDb(): DatabaseSync {
	return new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'wharfinger-driver-')), 'test.db'));
}

describe('asBytes', () => {
	it('passes Uint8Array through unchanged', () => {
		const b = new Uint8Array([1, 2, 3]);
		expect(asBytes(b)).toBe(b);
	});

	it('decodes the base64 text SurrealDB returns for blob columns', () => {
		const b = new Uint8Array([9, 8, 7, 6]);
		expect(asBytes(Buffer.from(b).toString('base64'))).toEqual(b);
	});

	it('returns null for other shapes', () => {
		expect(asBytes(null)).toBeNull();
		expect(asBytes(undefined)).toBeNull();
		expect(asBytes(42)).toBeNull();
		expect(asBytes({})).toBeNull();
	});
});

describe('SqliteDb', () => {
	it('adapts node:sqlite to the async Db contract', async () => {
		const raw = freshDb();
		const db = new SqliteDb(raw);
		expect(db.kind).toBe('sqlite');
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, flag INTEGER, blob BLOB)');
		const r = await db
			.prepare('INSERT INTO t (name, flag, blob) VALUES (?, ?, ?)')
			.run('a', true, new Uint8Array([1]));
		expect(r.changes).toBe(1);
		const row = (await db.prepare('SELECT flag, blob FROM t WHERE id = ?').get(1)) as {
			flag: number;
			blob: Uint8Array;
		};
		expect(row.flag).toBe(1);
		expect(row.blob).toEqual(new Uint8Array([1]));
		expect(await db.prepare('SELECT id FROM t WHERE id = ?').get(99)).toBeUndefined();
		expect(await db.prepare('SELECT id FROM t').all()).toHaveLength(1);
		await db.close();
	});

	it('rolls a failed transaction back', async () => {
		const db = new SqliteDb(freshDb());
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
		await expect(
			db.tx(async (tx) => {
				await tx.prepare('INSERT INTO t (id) VALUES (1)').run();
				throw new Error('boom');
			})
		).rejects.toThrow('boom');
		expect(await db.prepare('SELECT id FROM t').all()).toHaveLength(0);
		await db.close();
	});

	it('commits a successful transaction', async () => {
		const db = new SqliteDb(freshDb());
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
		const out = await db.tx(async (tx) => {
			await tx.prepare('INSERT INTO t (id) VALUES (1)').run();
			return 'done';
		});
		expect(out).toBe('done');
		expect(await db.prepare('SELECT id FROM t').all()).toHaveLength(1);
		await db.close();
	});

	it('serializes independent concurrent transactions', async () => {
		const db = new SqliteDb(freshDb());
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
		const order: string[] = [];
		await Promise.all([
			db.tx(async (tx) => {
				order.push('a-start');
				await tx.prepare('INSERT INTO t (id) VALUES (1)').run();
				await new Promise((r) => setTimeout(r, 30));
				order.push('a-end');
			}),
			db.tx(async (tx) => {
				order.push('b-start');
				await tx.prepare('INSERT INTO t (id) VALUES (2)').run();
				order.push('b-end');
			})
		]);
		// The second tx may only begin after the first commits; without
		// the queue sqlite throws on the nested BEGIN.
		expect(order.indexOf('b-start')).toBeGreaterThan(order.indexOf('a-end'));
		await db.close();
	});
});

describe('asDb / rawSqlite', () => {
	it('wraps a raw DatabaseSync and unwraps it again', () => {
		const raw = freshDb();
		const db = asDb(raw);
		expect(db).toBeInstanceOf(SqliteDb);
		expect(rawSqlite(db)).toBe(raw);
		expect(rawSqlite(raw)).toBe(raw);
		raw.close();
	});

	it('passes a Db through and reports no raw handle for surreal', () => {
		const raw = freshDb();
		const db = asDb(raw);
		expect(asDb(db)).toBe(db);
		const fake = { ...db, kind: 'surreal' as const };
		expect(rawSqlite(fake)).toBeNull();
		raw.close();
	});
});

describe('isUniqueViolation', () => {
	it('matches sqlite and surreal phrasings', () => {
		expect(isUniqueViolation(new Error('UNIQUE constraint failed: users.username'))).toBe(true);
		expect(isUniqueViolation(new Error("record already contains 'x'"))).toBe(true);
		expect(isUniqueViolation(new Error('other failure'))).toBe(false);
		expect(isUniqueViolation('UNIQUE constraint failed')).toBe(true);
		expect(isUniqueViolation(null)).toBe(false);
	});
});
