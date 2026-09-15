# Storage drivers

The hub persists through the `Db` interface in
`src/lib/server/store/driver.ts`. Two drivers exist:

- `sqlite` (default): `SqliteDb` wraps `node:sqlite` `DatabaseSync`.
  The calls resolve immediately; nothing else changes.
- `surreal`: `SurrealDb` (`src/lib/server/store/surreal.ts`) speaks
  JSON-RPC over one persistent WebSocket to `/rpc`, lazily connected
  on first statement. `src/lib/server/store/surrealql.ts` translates
  the portable SQL subset to SurrealQL at `prepare()` time.

`openStorage(cfg.storage)` in `store/db.ts` dispatches on
`[storage].driver`. `Runtime.db` is a `Db`; `Runtime.ready` resolves
once connect+schema+bootstrap finished and `handle` awaits it.

## Portable SQL subset

Stores write SQLite-flavored SQL that both drivers accept. Allowed:

- `SELECT ... FROM t WHERE ...` with `=`, `!=`, `<>`, `<`, `>`, `<=`,
  `>=`, `AND`, `OR`, `NOT`, `BETWEEN`, `IN (...)`, `IS [NOT] NULL`
- `INSERT INTO t (cols) VALUES (...)` single row, `INSERT OR IGNORE`,
  `INSERT INTO t SELECT`
- `ON CONFLICT(record-key-cols) DO UPDATE SET ...` with `excluded.x`
- `UPDATE t SET ... WHERE ...`, `DELETE FROM t WHERE ...`
- `RETURNING *`, `RETURNING id`, `RETURNING a, b`
- `COUNT(*)`, `COUNT(x)`, `SUM`, `AVG`, `MIN`, `MAX`, `CAST`,
  `COALESCE`, `IFNULL`, `LOWER`, `UPPER`, `TRIM`, `LENGTH`, `||`
- `ORDER BY`, `GROUP BY`, `LIMIT n OFFSET m`
- Correlated subqueries, `x < other_col` field compares

Forbidden (translator throws `SqlDialectError`; port explicitly):

- `JOIN`, `UNION`, `DISTINCT`, `LIKE`, `substr`, `GLOB`, `REGEXP`,
  `HAVING`, `WITH`, window functions, `COLLATE`, `PRAGMA`, DDL,
  `BEGIN`/`COMMIT`/`ROLLBACK` (use `db.tx()`), multi-row `VALUES`,
  `REPLACE INTO`, bare `SELECT` without `FROM`, `ON CONFLICT` on
  columns that are not the record key (e.g. `subscribers.url` -
  do `UPDATE ... WHERE key = ?` then `INSERT OR IGNORE` in a `db.tx`).

## Semantics notes

- Record ids: `id INTEGER PRIMARY KEY`/`AUTOINCREMENT` tables get a
  `seq:<table>` UPSERT counter (never resets, like AUTOINCREMENT).
  `TEXT PRIMARY KEY` tables store the pk value as the record id.
  Composite PKs store `id = [k1, k2, ...]`. Result rows map `id`
  back to the raw value.
- `.changes` comes from affected-row returns: UPDATE returns updated
  records, DELETE gets `RETURN BEFORE`, `INSERT IGNORE` dup gives 0.
- `lastInsertRowid` comes from an appended `RETURN VALUE id`.
- `INSERT OR IGNORE` and `ON DUPLICATE KEY UPDATE` cover record-id
  and secondary-unique conflicts the way sqlite does; non-record-key
  `ON CONFLICT` targets throw at prepare.
- Booleans bind as 0/1 on both drivers. `Uint8Array` binds as base64
  text on surreal; read side must use `asBytes` (in `lib/server/bytes`
  or normalize at the store) - see `avatar`, `public_key` sites.
- `IS NULL` maps to `IS NONE`; surreal writes `NONE` for sqlite NULL.
- Transactions: `db.tx(async (tx) => ...)` maps to BEGIN IMMEDIATE on
  sqlite and an interactive `begin`/`commit`/`cancel` WS txn on
  surreal. Nested tx() throws. `db.exec` multi-statement strings run
  as one implicit transaction on surreal.
- No FK cascade under surreal: `schema.ts` `cascades` lists the FK
  edges; delete paths must delete children explicitly in a tx.
- NOCASE unique on `users.username`: surreal maintains `username_lc`
  (fold shadow, translator-injected on INSERT/UPDATE of `username`)
  and lookups must branch `db.kind` to query `username_lc`.
- `migrate()` in db.ts is sqlite-only; surreal schema is `DEFINE
TABLE/INDEX` from `store/schema.ts`, idempotent at connect.
- The partial index `idx_users_external (source, external_id) WHERE
external_id IS NOT NULL` cannot be expressed; surreal enforces a
  plain unique on the pair, so stores must always write `external_id`
  (NONE is allowed once) or port to a code check.

## Config

```toml
[storage]
driver = "surreal"          # default "sqlite"
url = "ws://db.internal:8000"  # /rpc appended; http(s) maps to ws(s)
ns = "wharfinger"
db = "wharfinger"
user = "root"
pass = "${SURREAL_PASS}"
timeout_ms = 30000
```

Integration tests: `SURREAL_TEST_URL=ws://127.0.0.1:8000 pnpm vitest
run tests/unit/surreal-driver.test.ts` (skips when unset).
