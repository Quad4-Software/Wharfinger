import { describe, expect, it } from 'vitest';
import { translate, SqlDialectError } from '../../src/lib/server/store/surrealql';
import { isWord, render, tokenize } from '../../src/lib/server/store/surrealql-lex';
import { TABLE_META } from '../../src/lib/server/store/schema';

const t = (sql: string) => translate(sql, TABLE_META).surql;

describe('surrealql translate', () => {
	it('numbers params', () => {
		expect(t('SELECT * FROM users WHERE id = ? AND role = ?')).toBe(
			"SELECT * FROM users WHERE id = type::record('users', $p0) AND role = $p1"
		);
	});

	it('maps INSERT OR IGNORE', () => {
		expect(
			t('INSERT OR IGNORE INTO hub_keys (id, priv, pub, created_at) VALUES (?, ?, ?, ?)')
		).toBe(
			'INSERT IGNORE INTO hub_keys (id, priv, pub, created_at) VALUES ($p0, $p1, $p2, $p3) RETURN VALUE id'
		);
	});

	it('synthesizes seq ids for auto-increment tables', () => {
		expect(t('INSERT INTO markers (ts, title, kind) VALUES (?, ?, ?)')).toBe(
			'LET $_seq = (UPSERT seq:⟨markers⟩ SET v += 1 RETURN VALUE v)[0];INSERT INTO markers (id, ts, title, kind) VALUES ($_seq, $p0, $p1, $p2) RETURN VALUE id'
		);
	});

	it('synthesizes composite array ids', () => {
		expect(t('INSERT INTO team_members (team_id, user_id) VALUES (?, ?)')).toBe(
			'INSERT INTO team_members (id, team_id, user_id) VALUES ([$p0, $p1], $p0, $p1) RETURN VALUE id'
		);
	});

	it('keeps text pk inserts untouched', () => {
		expect(t('INSERT INTO agents (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)')).toBe(
			'INSERT INTO agents (id, name, token_hash, created_at) VALUES ($p0, $p1, $p2, $p3) RETURN VALUE id'
		);
	});

	it('maps ON CONFLICT DO UPDATE', () => {
		expect(
			t(
				'INSERT INTO push_beats (service_id, last_beat, beats, last_msg) VALUES (?, ?, 1, ?) ON CONFLICT(service_id) DO UPDATE SET last_beat = excluded.last_beat, beats = beats + 1, last_msg = excluded.last_msg'
			)
		).toBe(
			'INSERT INTO push_beats (id, service_id, last_beat, beats, last_msg) VALUES ($p0, $p0, $p1, 1, $p2) ON DUPLICATE KEY UPDATE last_beat = $input.last_beat, beats = (beats ?? 0) + 1, last_msg = $input.last_msg RETURN VALUE id'
		);
	});

	it('maps excluded refs and IS NULL', () => {
		expect(t('UPDATE users SET disabled_at = NULL WHERE id = ?')).toBe(
			"UPDATE users SET disabled_at = NONE WHERE id = type::record('users', $p0)"
		);
		expect(t('SELECT * FROM users WHERE disabled_at IS NULL AND id != ?')).toBe(
			"SELECT * FROM users WHERE disabled_at IS NONE AND id != type::record('users', $p0)"
		);
		expect(t('SELECT * FROM users WHERE disabled_at IS NOT NULL')).toBe(
			'SELECT * FROM users WHERE disabled_at IS NOT NONE'
		);
	});

	it('maps LIMIT OFFSET and IN lists', () => {
		expect(t('SELECT * FROM audit_log ORDER BY at DESC LIMIT ? OFFSET ?')).toBe(
			'SELECT * FROM audit_log ORDER BY at DESC LIMIT $p0 START $p1'
		);
		expect(t('SELECT * FROM jobs WHERE status IN (?, ?)')).toBe(
			'SELECT * FROM jobs WHERE status IN [$p0, $p1]'
		);
	});

	it('wraps id IN lists in type::record', () => {
		expect(t('SELECT * FROM markers WHERE id IN (?, ?)')).toBe(
			"SELECT * FROM markers WHERE id IN [type::record('markers', $p0), type::record('markers', $p1)]"
		);
	});

	it('maps aggregates', () => {
		expect(t('SELECT COUNT(*) AS c, AVG(latency) AS a FROM checks WHERE ok = 1')).toBe(
			'SELECT count() AS c, math::mean(latency) AS a FROM checks WHERE ok = 1 GROUP ALL'
		);
		expect(t('SELECT MAX(ts) AS m FROM checks')).toBe(
			'SELECT math::max(ts) AS m FROM checks GROUP ALL'
		);
		expect(t('SELECT service_id, COUNT(*) AS c FROM checks GROUP BY service_id')).toBe(
			'SELECT service_id, count() AS c FROM checks GROUP BY service_id'
		);
	});

	it('maps COALESCE and CAST', () => {
		expect(t("SELECT COALESCE(detail, '') AS d FROM checks")).toBe(
			"SELECT (detail ?? '') AS d FROM checks"
		);
		expect(t('SELECT CAST(ts / ? AS INTEGER) AS b FROM checks GROUP BY b')).toBe(
			'SELECT math::floor(ts / $p0) AS b FROM checks GROUP BY b'
		);
	});

	it('maps RETURNING', () => {
		expect(t('DELETE FROM jobs WHERE id = ? RETURNING *')).toBe(
			"DELETE FROM jobs WHERE id = type::record('jobs', $p0) RETURN BEFORE"
		);
		expect(t('UPDATE jobs SET status = ? WHERE id = ? RETURNING id')).toBe(
			"UPDATE jobs SET status = $p0 WHERE id = type::record('jobs', $p1) RETURN VALUE id"
		);
	});

	it('injects fold shadow cols on insert and update', () => {
		expect(
			t(
				'INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)'
			)
		).toBe(
			'LET $_seq = (UPSERT seq:⟨users⟩ SET v += 1 RETURN VALUE v)[0];INSERT INTO users (id, username, display_name, password_hash, role, created_at, username_lc) VALUES ($_seq, $p0, $p1, $p2, $p3, $p4, string::lowercase($p0)) RETURN VALUE id'
		);
		expect(t('UPDATE users SET username = ? WHERE id = ?')).toBe(
			"UPDATE users SET username = $p0, username_lc = string::lowercase($p0) WHERE id = type::record('users', $p1)"
		);
	});

	it('maps concat and <>', () => {
		expect(t('UPDATE jobs SET log = log || ? WHERE id = ?')).toBe(
			"UPDATE jobs SET log = log + $p0 WHERE id = type::record('jobs', $p1)"
		);
		expect(t("SELECT * FROM users WHERE username != 'root'")).toBe(
			"SELECT * FROM users WHERE username != 'root'"
		);
	});

	it('maps IN-subqueries to VALUE', () => {
		expect(
			t('DELETE FROM checks WHERE service_id NOT IN (SELECT service_id FROM service_state)')
		).toBe(
			'DELETE FROM checks WHERE service_id NOT IN (SELECT VALUE service_id FROM service_state) RETURN BEFORE'
		);
	});

	it('rewrites BETWEEN as a range pair', () => {
		expect(
			t(
				'SELECT * FROM markers WHERE ts BETWEEN ? AND ? AND (? IS NULL OR service IS NULL OR service = ?)'
			)
		).toBe(
			'SELECT * FROM markers WHERE (ts >= $p0 AND ts <= $p1) AND ($p2 IS NONE OR service IS NONE OR service = $p3)'
		);
		expect(t('SELECT * FROM a WHERE t.x BETWEEN 1 AND 9')).toBe(
			'SELECT * FROM a WHERE (t.x >= 1 AND t.x <= 9)'
		);
	});

	it('adds ORDER BY fields to the projection', () => {
		expect(t('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1')).toBe(
			'SELECT hash, id FROM audit_log ORDER BY id DESC LIMIT 1'
		);
		// star projections and already-selected fields are untouched
		expect(t('SELECT * FROM checks ORDER BY ts DESC')).toBe(
			'SELECT * FROM checks ORDER BY ts DESC'
		);
		expect(t('SELECT ts, ok FROM checks ORDER BY ts')).toBe(
			'SELECT ts, ok FROM checks ORDER BY ts'
		);
	});

	it('throws on non-portable constructs', () => {
		expect(() => t('SELECT * FROM a JOIN b ON a.id = b.id')).toThrow(SqlDialectError);
		expect(() => t('SELECT DISTINCT kind FROM markers')).toThrow(SqlDialectError);
		expect(() => t("SELECT * FROM users WHERE username LIKE 'a%'")).toThrow(SqlDialectError);
		expect(() => t('SELECT substr(body, -10) FROM chat_messages')).toThrow(SqlDialectError);
		expect(() => t('PRAGMA journal_mode = WAL')).toThrow(SqlDialectError);
		expect(() => t('BEGIN IMMEDIATE')).toThrow(SqlDialectError);
		expect(() => t('CREATE TABLE x (a INTEGER)')).toThrow(SqlDialectError);
		expect(() => t('SELECT 1')).toThrow(SqlDialectError);
		expect(() => t('SELECT * FROM a UNION ALL SELECT * FROM b')).toThrow(SqlDialectError);
	});
});

describe('surrealql lexer', () => {
	it('tokenizes params, strings, and paren depth', () => {
		const toks = tokenize("SELECT * FROM t WHERE a = ? AND b IN ('x', ?)");
		expect(toks.map((x) => x.t)).toContain('param');
		expect(toks.filter((x) => x.t === 'param')).toHaveLength(2);
		const open = toks.find((x) => x.v === '(');
		const close = toks.find((x) => x.v === ')');
		// ')' records the depth after popping back out of the group
		expect(open?.depth).toBe(0);
		expect(close?.depth).toBe(0);
		expect(toks.find((x) => x.v === "'x'")?.t).toBe('str');
	});

	it('isWord matches case-insensitively', () => {
		const toks = tokenize('select 1 from t');
		expect(isWord(toks[0], 'SELECT')).toBe(true);
		expect(isWord(toks[0], 'FROM')).toBe(false);
		expect(isWord(undefined, 'SELECT')).toBe(false);
	});

	it('render rejoins tokens with spacing rules', () => {
		expect(render(tokenize('SELECT count(*) FROM t'))).toBe('SELECT count(*) FROM t');
	});
});
