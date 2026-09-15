import type { Db, Row } from '$lib/server/store/driver';

/**
 * Full-backup data tables. Every secret field in these tables is
 * sealed at rest (deploy_keys.priv, secret_sets.sealed, deploy_apps
 * env/hook_secret/forge_token, hub_keys.priv/secret), so the export
 * carries sealed blobs that only open on a hub with the same
 * WHARFINGER_SECRET_KEY. Agent and api key rows carry hashes, not
 * tokens, so a restore preserves enrollments without ever writing
 * plaintext credentials anywhere.
 */
const DATA_TABLES: { table: string; pk: string }[] = [
	{ table: 'deploy_apps', pk: 'id' },
	{ table: 'deploy_keys', pk: 'app_id' },
	{ table: 'deploy_releases', pk: 'id' },
	{ table: 'hub_keys', pk: 'id' },
	{ table: 'secret_sets', pk: 'id' },
	{ table: 'agents', pk: 'id' },
	{ table: 'api_keys', pk: 'id' }
];

const MAX_ROWS = 50_000;
const COL_RE = /^[a-z_][a-z0-9_]*$/;
// Deploy rows can embed preview rows pointing at their parents, so
// parents must exist first; the table order above keeps REFERENCES
// targets ahead of their dependents.
const TABLE_ORDER = new Map(DATA_TABLES.map((t, i) => [t.table, i]));

function scalar(v: unknown): v is string | number | boolean | null {
	return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/** Dump the data tables as row objects. Scalar fields only. */
export async function exportData(db: Db): Promise<Record<string, Row[]>> {
	const out: Record<string, Row[]> = {};
	for (const { table } of DATA_TABLES) {
		const rows = await db.prepare(`SELECT * FROM ${table}`).all();
		out[table] = rows.map((r) => {
			const clean: Row = {};
			for (const [k, v] of Object.entries(r)) {
				if (scalar(v)) clean[k] = v;
			}
			return clean;
		});
	}
	return out;
}

/**
 * Restore data tables from a backup. Each table is replaced row by
 * row (delete + insert inside one transaction per table) so the
 * restore is atomic per table and portable across both drivers.
 * Unknown tables and malformed rows are skipped and reported.
 */
export async function importData(
	db: Db,
	data: Record<string, unknown>
): Promise<{ applied: string[]; failed: { table: string; error: string }[] }> {
	const applied: string[] = [];
	const failed: { table: string; error: string }[] = [];
	const entries = Object.entries(data).sort(
		(a, b) => (TABLE_ORDER.get(a[0]) ?? 99) - (TABLE_ORDER.get(b[0]) ?? 99)
	);
	for (const [table, rows] of entries) {
		const meta = DATA_TABLES.find((t) => t.table === table);
		if (!meta) {
			failed.push({ table, error: 'not a restorable table' });
			continue;
		}
		if (!Array.isArray(rows) || rows.length > MAX_ROWS) {
			failed.push({ table, error: 'bad row list' });
			continue;
		}
		try {
			await db.tx(async (tx) => {
				const del = tx.prepare(`DELETE FROM ${table} WHERE ${meta.pk} = ?`);
				for (const raw of (rows as unknown[]).slice(0, MAX_ROWS)) {
					if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
						throw new Error('row is not an object');
					}
					const cols: string[] = [];
					const vals: (string | number | null)[] = [];
					for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
						if (!COL_RE.test(k)) continue;
						if (!scalar(v)) continue;
						cols.push(k);
						vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
					}
					const pkIdx = cols.indexOf(meta.pk);
					if (pkIdx < 0) throw new Error(`row missing pk ${meta.pk}`);
					await del.run(vals[pkIdx]);
					await tx
						.prepare(
							`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
						)
						.run(...vals);
				}
			});
			applied.push(table);
		} catch (err) {
			failed.push({ table, error: err instanceof Error ? err.message : 'restore failed' });
		}
	}
	return { applied, failed };
}
