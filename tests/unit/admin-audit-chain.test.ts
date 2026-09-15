import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '$lib/server/store/db';
import { AUDIT_GENESIS, AuditStore } from '$lib/server/admin/audit';

process.env.WHARFINGER_SECRET_KEY = 'unit-test-secret-key-material';

function freshDir(): string {
	return mkdtempSync(join(tmpdir(), 'wharfinger-audit-'));
}

interface ChainRow {
	id: number;
	prev_hash: string | null;
	hash: string | null;
}

describe('audit hash chain', () => {
	it('verifies an empty log', async () => {
		const audit = new AuditStore(openDb(freshDir()));
		expect(await audit.verify()).toEqual({ ok: true, rows: 0 });
	});

	it('chains new rows from genesis and verifies', async () => {
		const db = openDb(freshDir());
		const audit = new AuditStore(db);
		await audit.log({ action: 'a', username: 'alice' });
		await audit.log({ action: 'b', detail: 'd', ip: '10.0.0.1' });
		await audit.log({ action: 'c' });

		const rows = db
			.prepare('SELECT id, prev_hash, hash FROM audit_log ORDER BY id')
			.all() as unknown as ChainRow[];
		expect(rows).toHaveLength(3);
		expect(rows[0].prev_hash).toBe(AUDIT_GENESIS);
		expect(rows.every((r) => typeof r.hash === 'string' && r.hash.length === 64)).toBe(true);
		expect(rows[1].prev_hash).toBe(rows[0].hash);
		expect(rows[2].prev_hash).toBe(rows[1].hash);

		expect(await audit.verify()).toEqual({ ok: true, rows: 3 });
	});

	it('reports a tampered row by id', async () => {
		const db = openDb(freshDir());
		const audit = new AuditStore(db);
		for (let i = 0; i < 5; i++) await audit.log({ action: `act${i}` });
		db.prepare("UPDATE audit_log SET detail = 'forged' WHERE id = 3").run();
		expect(await audit.verify()).toEqual({ ok: false, rows: 3, firstBadId: 3 });
	});

	it('reports a relinked prev_hash', async () => {
		const db = openDb(freshDir());
		const audit = new AuditStore(db);
		for (let i = 0; i < 3; i++) await audit.log({ action: `act${i}` });
		db.prepare("UPDATE audit_log SET prev_hash = 'beef' WHERE id = 2").run();
		const r = await audit.verify();
		expect(r.ok).toBe(false);
		expect(r.firstBadId).toBe(2);
	});

	it('tolerates pruned head rows whose prev_hash dangles', async () => {
		const db = openDb(freshDir());
		const audit = new AuditStore(db);
		for (let i = 0; i < 5; i++) await audit.log({ action: `act${i}` });
		db.prepare('DELETE FROM audit_log WHERE id <= 2').run();
		expect(await audit.verify()).toEqual({ ok: true, rows: 3 });
	});

	it('backfills pre-chain rows oldest-first on open', async () => {
		const dir = freshDir();
		const db = openDb(dir);
		const audit = new AuditStore(db);
		await audit.log({ action: 'chained' });
		// Rows written by a pre-chain version carry no hashes.
		db.prepare(
			"INSERT INTO audit_log (user_id, username, action, detail, ip, at) VALUES (1, 'bob', 'old1', NULL, NULL, 1000)"
		).run();
		db.prepare(
			"INSERT INTO audit_log (user_id, username, action, detail, ip, at) VALUES (NULL, NULL, 'old2', 'x', '1.2.3.4', 2000)"
		).run();
		db.close();

		const db2 = openDb(dir);
		const rows = db2
			.prepare('SELECT id, prev_hash, hash FROM audit_log ORDER BY id')
			.all() as unknown as ChainRow[];
		expect(rows.every((r) => r.hash !== null)).toBe(true);
		expect(rows[1].prev_hash).toBe(rows[0].hash);
		expect(rows[2].prev_hash).toBe(rows[1].hash);
		expect(await new AuditStore(db2).verify()).toEqual({ ok: true, rows: 3 });
	});
});
