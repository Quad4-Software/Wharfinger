import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '$lib/server/store/db';
import { asDb, type Db } from '$lib/server/store/driver';
import { exportData, importData } from '$lib/server/admin/backup-data';

let db: Db | undefined;
function fresh(): Db {
	const dir = mkdtempSync(join(tmpdir(), 'q4s-bak-'));
	db = asDb(openDb(dir));
	return db;
}

afterEach(async () => {
	await db?.close();
});

async function seed(d: Db): Promise<void> {
	await d
		.prepare(
			`INSERT INTO deploy_apps (id, name, agent_id, source, runtime, webhook_hash, created_at, updated_at)
			 VALUES ('app_a', 'shop', 'ag1', '{}', 'podman', 'wh1', 1, 1)`
		)
		.run();
	await d
		.prepare(
			`INSERT INTO deploy_releases (id, app_id, spec, status, created_at)
			 VALUES ('rel_a', 'app_a', '{}', 'live', 1)`
		)
		.run();
	await d
		.prepare(`INSERT INTO deploy_keys (app_id, pub, priv) VALUES ('app_a', 'p', 'sealed')`)
		.run();
	await d
		.prepare(
			`INSERT INTO api_keys (name, key_hash, scopes, created_by, created_at)
			 VALUES ('auto', 'h', 'read', 'test', 1)`
		)
		.run();
}

describe('backup data export', () => {
	it('dumps the deploy and sealed-key tables', async () => {
		const d = fresh();
		await seed(d);
		const data = await exportData(d);
		expect(Object.keys(data).sort()).toEqual(
			[
				'api_keys',
				'agents',
				'deploy_apps',
				'deploy_keys',
				'deploy_releases',
				'hub_keys',
				'secret_sets'
			].sort()
		);
		expect(data.deploy_apps[0].name).toBe('shop');
		expect(data.deploy_keys[0].priv).toBe('sealed');
	});
});

describe('backup data import', () => {
	it('restores rows into an empty database', async () => {
		const src = fresh();
		await seed(src);
		const data = await exportData(src);

		const dst = asDb(openDb(mkdtempSync(join(tmpdir(), 'q4s-bak2-'))));
		const res = await importData(dst, data);
		expect(res.failed).toEqual([]);
		expect(res.applied).toContain('deploy_apps');
		expect(res.applied).toContain('deploy_releases');
		const rows = await dst.prepare('SELECT name FROM deploy_apps').all();
		expect(rows).toEqual([{ name: 'shop' }]);
		await dst.close();
	});

	it('overwrites existing rows rather than duplicating them', async () => {
		const d = fresh();
		await seed(d);
		const data = await exportData(d);
		// Mutate, then restore from the export.
		await d.prepare("UPDATE deploy_apps SET name = 'changed' WHERE id = 'app_a'").run();
		const res = await importData(d, data);
		expect(res.failed).toEqual([]);
		const rows = (await d.prepare('SELECT name FROM deploy_apps').all()) as {
			name: string;
		}[];
		expect(rows).toEqual([{ name: 'shop' }]);
	});

	it('rejects unknown tables and malformed rows without touching valid ones', async () => {
		const d = fresh();
		const res = await importData(d, {
			jobs: [{ id: 1 }],
			deploy_apps: [
				{ name: 'no-pk' },
				{
					id: 'app_b',
					name: 'ok',
					agent_id: 'a',
					source: '{}',
					runtime: 'podman',
					webhook_hash: 'w',
					created_at: 1,
					updated_at: 1
				}
			]
		});
		expect(res.failed.map((f) => f.table)).toContain('jobs');
		// deploy_apps fails on the pk-less row, inside its tx
		expect(res.failed.map((f) => f.table)).toContain('deploy_apps');
	});

	it('rejects non-object data and oversized tables', async () => {
		const d = fresh();
		const res = await importData(d, { agents: 'nope', api_keys: [] });
		expect(res.failed.map((f) => f.table)).toContain('agents');
		expect(res.applied).toContain('api_keys');
	});
});
