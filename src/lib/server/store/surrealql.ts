// Translates the portable SQLite-flavored subset used by Wharfinger
// stores into SurrealQL. The contract with stores is documented in
// .agents/references/storage.md. Anything outside the subset throws
// SqlDialectError loudly at prepare() time instead of silently
// misbehaving; those call sites get an explicit db.kind branch.
//
// Key mappings:
//   ?                        -> $p0, $p1, ...
//   INSERT OR IGNORE         -> INSERT IGNORE
//   ON CONFLICT..DO UPDATE   -> ON DUPLICATE KEY UPDATE ($input.)
//   ON CONFLICT..DO NOTHING  -> INSERT IGNORE
//   RETURNING *              -> RETURN AFTER
//   RETURNING id             -> RETURN VALUE id
//   IS [NOT] NULL            -> IS [NOT] NONE
//   LIMIT n OFFSET m         -> LIMIT n START m
//   IN (...)                 -> IN [...]
//   id = ?                   -> id = type::record('table', ?)
//   CAST(x AS INTEGER)       -> math::floor(x)
//   COALESCE(a, b)           -> (a ?? b)
//   COUNT/SUM/AVG/MIN/MAX    -> count()/math::*()
//   ||                       -> +
//   missing int id           -> seq:<table> UPSERT counter

import { RESERVED, isWord, render, tokenize, type Tok } from './surrealql-lex';

export class SqlDialectError extends Error {}

export interface TableMeta {
	/** pk kind drives record-id synthesis. */
	pk: 'int' | 'text' | 'composite' | 'none';
	pkCols: string[];
	/** NOCASE shadow cols: writes to col also write folds[col] = lowercase(col). */
	folds?: Record<string, string>;
}

export interface Translated {
	surql: string;
	/** true when the statement appends RETURN VALUE id for lastInsertRowid */
	returnsId: boolean;
}

export function translate(sql: string, tables: Map<string, TableMeta>): Translated {
	const toks = tokenize(sql);
	if (toks.length === 0) throw new SqlDialectError('empty statement');
	// strip trailing semicolon
	while (toks.length && toks[toks.length - 1].v === ';') toks.pop();
	if (toks.some((t) => t.v === ';'))
		throw new SqlDialectError('multiple statements: ' + sql.slice(0, 60));

	const first = toks[0].v.toUpperCase();
	const forbidden = (w: string, why: string) => {
		if (toks.some((t) => t.t === 'word' && t.v.toUpperCase() === w))
			throw new SqlDialectError(`${why} not portable: ${sql.slice(0, 80)}`);
	};
	forbidden('PRAGMA', 'PRAGMA');
	forbidden('ATTACH', 'ATTACH');
	forbidden('VACUUM', 'VACUUM');
	forbidden('GLOB', 'GLOB');
	forbidden('REGEXP', 'REGEXP');
	forbidden('MATCH', 'FTS MATCH');
	forbidden('HAVING', 'HAVING');
	forbidden('INTERSECT', 'INTERSECT');
	forbidden('EXCEPT', 'EXCEPT');
	forbidden('ROW_NUMBER', 'window function');
	forbidden('LAG', 'window function');
	forbidden('COLLATE', 'COLLATE');
	if (toks.some((t) => t.v === 'OVER')) throw new SqlDialectError('window OVER not portable');
	if (first === 'BEGIN' || first === 'COMMIT' || first === 'ROLLBACK')
		throw new SqlDialectError('use db.tx(), never raw transaction statements');
	if (first === 'CREATE' || first === 'ALTER' || first === 'DROP')
		throw new SqlDialectError('DDL must go through the driver schema path');
	if (first === 'WITH') throw new SqlDialectError('CTE not portable');
	if (toks.some((t) => isWord(t, 'JOIN')) || toks.some((t) => isWord(t, 'UNION')))
		throw new SqlDialectError('JOIN/UNION not portable, split the query');
	if (toks.some((t) => isWord(t, 'DISTINCT')))
		throw new SqlDialectError('DISTINCT not portable, use GROUP BY or js dedupe');
	if (toks.some((t) => isWord(t, 'LIKE')))
		throw new SqlDialectError('LIKE not portable, use kind-conditional string fns');
	if (toks.some((t) => isWord(t, 'SUBSTR')))
		throw new SqlDialectError('substr not portable, use kind-conditional slice');
	if (toks.some((t) => isWord(t, 'AUTOINCREMENT'))) throw new SqlDialectError('DDL');
	if (first === 'REPLACE') throw new SqlDialectError('REPLACE INTO not portable');

	// per-depth table tracking for id comparisons
	const tableAt = new Map<number, string>();
	for (let i = 0; i < toks.length - 1; i++) {
		const t = toks[i];
		if (t.t !== 'word') continue;
		const up = t.v.toUpperCase();
		if (up === 'FROM' || up === 'INTO' || up === 'UPDATE') {
			const next = toks[i + 1];
			if (next.t === 'word') tableAt.set(t.depth, next.v);
		}
	}
	const table = (d: number): string | undefined => tableAt.get(d);

	let pi = 0;
	const pnum = () => `$p${pi++}`;
	let insertIgnore = false;
	let returnsId = false;

	const word = (v: string): Tok => ({ t: 'word', v, depth: 0 });
	const op = (v: string): Tok => ({ t: 'op', v, depth: 0 });
	const punct = (v: string, depth: number): Tok => ({ t: 'punct', v, depth });

	const emitExpr = (i0: number, i1: number): (Tok | string)[] => {
		// recursively rewrite the token range [i0, i1)
		const sub = rewriteRange(i0, i1);
		return sub;
	};

	function rewriteRange(i0: number, i1: number): (Tok | string)[] {
		const r: (Tok | string)[] = [];
		let i = i0;
		let dupAt = -1;
		const finish = (): (Tok | string)[] => {
			if (dupAt >= 0) {
				// col = col OP expr -> col = (col ?? 0) OP expr so the
				// clause stays valid when it is evaluated on insert
				for (let k = dupAt; k < r.length - 3; k++) {
					const a = r[k];
					const eq = r[k + 1];
					const b = r[k + 2];
					const o = r[k + 3];
					const av = typeof a === 'string' ? a : a.v;
					const bv = typeof b === 'string' ? b : b.v;
					const ov = typeof o === 'string' ? o : o.v;
					const eqv = typeof eq === 'string' ? eq : eq.v;
					if (
						eqv === '=' &&
						av === bv &&
						!av.startsWith('$') &&
						['+', '-', '*', '/'].includes(ov)
					) {
						r[k + 2] = `(${bv} ?? 0)`;
					}
				}
			}
			return r;
		};
		while (i < i1) {
			const t = toks[i];
			if (t.t === 'param') {
				r.push(pnum());
				i++;
				continue;
			}
			if (t.t === 'word') {
				const up = t.v.toUpperCase();
				if (up === 'CAST' && toks[i + 1]?.v === '(') {
					// CAST ( expr AS TYPE )
					let j = i + 2;
					const d = toks[i + 1].depth + 1;
					let asIdx = -1;
					while (j < i1 && !(toks[j].v === ')' && toks[j].depth === toks[i + 1].depth)) {
						if (isWord(toks[j], 'AS') && toks[j].depth === d) asIdx = j;
						j++;
					}
					const ty = (toks[j - 1]?.v ?? '').toUpperCase();
					const inner = emitExpr(i + 2, asIdx >= 0 ? asIdx : j);
					if (ty === 'INTEGER' || ty === 'INT') {
						r.push('math::floor', punct('(', 0), ...inner, punct(')', 0));
					} else if (ty === 'REAL' || ty === 'FLOAT') {
						r.push('type::float', punct('(', 0), ...inner, punct(')', 0));
					} else {
						r.push('type::string', punct('(', 0), ...inner, punct(')', 0));
					}
					i = j + 1;
					continue;
				}
				if (up === 'COALESCE' && toks[i + 1]?.v === '(') {
					let j = i + 2;
					const pd = toks[i + 1].depth;
					const args: (Tok | string)[][] = [];
					let start = i + 2;
					while (j < i1 && !(toks[j].v === ')' && toks[j].depth === pd)) {
						if (toks[j].v === ',' && toks[j].depth === pd + 1) {
							args.push(emitExpr(start, j));
							start = j + 1;
						}
						j++;
					}
					args.push(emitExpr(start, j));
					r.push(punct('(', 0));
					args.forEach((a, k) => {
						if (k > 0) r.push(op('??'));
						r.push(...a);
					});
					r.push(punct(')', 0));
					i = j + 1;
					continue;
				}
				if (up === 'COUNT' && toks[i + 1]?.v === '(') {
					// drop '*' arg: count(*) -> count()
					if (toks[i + 2]?.v === '*' && toks[i + 3]?.v === ')') {
						r.push('count()');
						i += 4;
						continue;
					}
					r.push('count', toks[i + 1]);
					i += 2;
					continue;
				}
				if (
					(up === 'SUM' || up === 'AVG' || up === 'MIN' || up === 'MAX') &&
					toks[i + 1]?.v === '('
				) {
					const fn =
						up === 'SUM'
							? 'math::sum'
							: up === 'AVG'
								? 'math::mean'
								: up === 'MIN'
									? 'math::min'
									: 'math::max';
					r.push(fn, toks[i + 1]);
					i += 2;
					continue;
				}
				if (up === 'LOWER' && toks[i + 1]?.v === '(') {
					r.push('string::lowercase', toks[i + 1]);
					i += 2;
					continue;
				}
				if (up === 'UPPER' && toks[i + 1]?.v === '(') {
					r.push('string::uppercase', toks[i + 1]);
					i += 2;
					continue;
				}
				if (up === 'TRIM' && toks[i + 1]?.v === '(') {
					r.push('string::trim', toks[i + 1]);
					i += 2;
					continue;
				}
				if (up === 'LENGTH' && toks[i + 1]?.v === '(') {
					r.push('string::len', toks[i + 1]);
					i += 2;
					continue;
				}
				if (up === 'IFNULL' && toks[i + 1]?.v === '(') {
					// same handling as COALESCE
					let j = i + 2;
					const pd = toks[i + 1].depth;
					const args: (Tok | string)[][] = [];
					let start = i + 2;
					while (j < i1 && !(toks[j].v === ')' && toks[j].depth === pd)) {
						if (toks[j].v === ',' && toks[j].depth === pd + 1) {
							args.push(emitExpr(start, j));
							start = j + 1;
						}
						j++;
					}
					args.push(emitExpr(start, j));
					r.push(punct('(', 0));
					args.forEach((a, k) => {
						if (k > 0) r.push(op('??'));
						r.push(...a);
					});
					r.push(punct(')', 0));
					i = j + 1;
					continue;
				}
				if (up === 'NULL') {
					r.push('NONE');
					i++;
					continue;
				}
				if (t.v.startsWith('excluded.')) {
					r.push('$input.' + t.v.slice(9));
					i++;
					continue;
				}
				if (up === 'ON' && isWord(toks[i + 1], 'CONFLICT')) {
					let k = i + 2;
					if (toks[k]?.v === '(') {
						const pd = toks[k].depth;
						k++;
						while (k < i1 && !(toks[k].v === ')' && toks[k].depth === pd)) k++;
						k++;
					}
					if (isWord(toks[k], 'DO') && isWord(toks[k + 1], 'UPDATE')) {
						r.push('ON', 'DUPLICATE', 'KEY', 'UPDATE');
						dupAt = r.length;
						i = k + 2;
						if (isWord(toks[i], 'SET')) i++;
						continue;
					}
					if (isWord(toks[k], 'DO') && isWord(toks[k + 1], 'NOTHING')) {
						break; // drop the whole clause
					}
				}
				if (up === 'TRUE') {
					r.push('true');
					i++;
					continue;
				}
				if (up === 'FALSE') {
					r.push('false');
					i++;
					continue;
				}
				if (up === 'IS' && isWord(toks[i + 1], 'NULL')) {
					r.push('IS', 'NONE');
					i += 2;
					continue;
				}
				if (up === 'IS' && isWord(toks[i + 1], 'NOT') && isWord(toks[i + 2], 'NULL')) {
					r.push('IS', 'NOT', 'NONE');
					i += 3;
					continue;
				}
				// id comparison: id <op> <value>
				if (
					t.v === 'id' &&
					toks[i + 1]?.t === 'op' &&
					['=', '!=', '<>', '<', '<=', '>', '>='].includes(toks[i + 1].v)
				) {
					const tbl = table(t.depth);
					const o = toks[i + 1].v === '<>' ? '!=' : toks[i + 1].v;
					const rhs = toks.at(i + 2);
					if (tbl && rhs && (rhs.t === 'param' || rhs.t === 'num' || rhs.t === 'str')) {
						const rv = rhs.t === 'param' ? pnum() : rhs.v;
						r.push(word('id'), op(o), `type::record('${tbl}', ${rv})`);
						i += 3;
						continue;
					}
					r.push(word('id'), op(o));
					i += 2;
					continue;
				}
				if (up === 'NOT' && isWord(toks[i + 1], 'IN')) {
					r.push('NOT');
					i++;
					continue;
				}
				if (up === 'IN' && toks[i + 1]?.v === '(') {
					const inner = toks.at(i + 2);
					if (inner && isWord(inner, 'SELECT')) {
						// id IN (SELECT ...) or col IN (SELECT col ...)
						r.push('IN', toks[i + 1], 'SELECT', 'VALUE');
						i += 3;
						continue;
					}
					// IN (a, b, ?) -> IN [a, b, $p]
					const lhsTok = isWord(toks[i - 1], 'NOT') ? toks.at(i - 2) : toks.at(i - 1);
					const idIn = lhsTok?.t === 'word' && lhsTok.v === 'id';
					const tbl = table(t.depth);
					r.push('IN', '[');
					i += 2;
					// rewrite elements until matching )
					const pd = toks[i - 1].depth + 1;
					while (i < i1 && !(toks[i].v === ')' && toks[i].depth === pd - 1)) {
						if (toks[i].t === 'param') {
							const v = pnum();
							r.push(idIn && tbl ? `type::record('${tbl}', ${v})` : v);
							i++;
							continue;
						}
						if (toks[i].v === ',') {
							r.push(',');
							i++;
							continue;
						}
						if (idIn && tbl && (toks[i].t === 'num' || toks[i].t === 'str')) {
							r.push(`type::record('${tbl}', ${toks[i].v})`);
							i++;
							continue;
						}
						r.push(toks[i]);
						i++;
					}
					r.push(']');
					i++; // consume )
					continue;
				}
				r.push(t);
				i++;
				continue;
			}
			if (t.t === 'op' && t.v === '||') {
				r.push(op('+'));
				i++;
				continue;
			}
			if (t.t === 'op' && t.v === '<>') {
				r.push(op('!='));
				i++;
				continue;
			}
			r.push(t);
			i++;
		}
		return finish();
	}

	// statement-level handling
	if (first === 'INSERT') {
		let i = 1;
		if (isWord(toks[i], 'OR') && isWord(toks[i + 1], 'IGNORE')) {
			insertIgnore = true;
			i += 2;
		}
		if (!isWord(toks[i], 'INTO')) throw new SqlDialectError('INSERT must use INTO');
		i++;
		const tblTok = toks[i];
		if (tblTok.t !== 'word') throw new SqlDialectError('INSERT INTO <table>');
		const tbl = tblTok.v;
		i++;
		const meta = tables.get(tbl) ?? { pk: 'none', pkCols: [] };

		// ON CONFLICT ... DO NOTHING anywhere -> insert ignore.
		// ON CONFLICT(cols) DO UPDATE only ports when cols are the
		// record key; secondary-unique upserts throw for hand porting.
		for (let k = i; k < toks.length - 2; k++) {
			if (isWord(toks[k], 'ON') && isWord(toks[k + 1], 'CONFLICT')) {
				let j = k + 2;
				const conflictCols: string[] = [];
				if (toks[j]?.v === '(') {
					j++;
					while (j < toks.length && toks[j].v !== ')') {
						if (toks[j].t === 'word') conflictCols.push(toks[j].v);
						j++;
					}
					j++;
				}
				if (isWord(toks[j], 'DO') && isWord(toks[j + 1], 'NOTHING')) {
					insertIgnore = true;
				} else if (isWord(toks[j], 'DO') && isWord(toks[j + 1], 'UPDATE')) {
					const meta2 = tables.get(tbl) ?? { pk: 'none' as const, pkCols: [] };
					const key = meta2.pk === 'composite' || meta2.pk === 'text' ? meta2.pkCols : ['id'];
					const same =
						conflictCols.length === key.length && conflictCols.every((c) => key.includes(c));
					if (!same)
						throw new SqlDialectError(
							`ON CONFLICT (${conflictCols.join(',')}) on ${tbl} is not the record key; port with db.kind`
						);
				}
			}
		}

		const head: (Tok | string)[] = ['INSERT'];
		if (insertIgnore) head.push('IGNORE');
		head.push('INTO', word(tbl));

		// column list
		let cols: string[] = [];
		let afterCols = i;
		if (toks[i]?.v === '(') {
			const pd = toks[i].depth;
			let j = i + 1;
			while (j < toks.length && !(toks[j].v === ')' && toks[j].depth === pd)) {
				if (toks[j].t === 'word') cols.push(toks[j].v);
				j++;
			}
			afterCols = j + 1;
		}

		if (isWord(toks[afterCols], 'SELECT')) {
			// INSERT INTO t SELECT ... -> INSERT INTO t (SELECT ...)
			const body = emitExpr(afterCols, toks.length);
			return { surql: render([...head, punct('(', 0), ...body, punct(')', 0)]), returnsId: false };
		}
		if (!isWord(toks[afterCols], 'VALUES'))
			throw new SqlDialectError('INSERT needs VALUES or SELECT');

		// single VALUES row only
		let j = afterCols + 1;
		if (toks[j]?.v !== '(') throw new SqlDialectError('VALUES must be parenthesized');
		const rowStart = j;
		const pd = toks[j].depth;
		let rowEnd = -1;
		while (j < toks.length) {
			if (toks[j].v === ')' && toks[j].depth === pd) {
				rowEnd = j;
				break;
			}
			j++;
		}
		if (rowEnd < 0) throw new SqlDialectError('unterminated VALUES');
		if (isWord(toks[rowEnd + 1], 'VALUES') || toks[rowEnd + 1]?.v === ',') {
			// multi-row: check next non-commas
			let k = rowEnd + 1;
			while (toks[k]?.v === ',') k++;
			if (toks[k]?.v === '(') throw new SqlDialectError('multi-row VALUES not portable');
		}

		// split value exprs at row-depth commas, computing param indices
		const vals: (Tok | string)[][] = [];
		{
			let start = rowStart + 1;
			for (let k = rowStart + 1; k <= rowEnd; k++) {
				if (k === rowEnd || (toks[k].v === ',' && toks[k].depth === pd + 1)) {
					vals.push(emitExpr(start, k));
					start = k + 1;
				}
			}
		}

		// fold shadow cols: username -> username_lc = string::lowercase(username)
		for (const [col, shadow] of Object.entries(meta.folds ?? {})) {
			const idx = cols.indexOf(col);
			if (idx >= 0) {
				cols = [...cols, shadow];
				vals.push(['string::lowercase', punct('(', 0), ...vals[idx], punct(')', 0)]);
			}
		}

		const hasId = cols.includes('id');
		const seqVar = '$_seq';

		let idExpr: (Tok | string)[] | null = null;
		if (!hasId && meta.pk === 'composite') {
			// id = [pk0, pk1, ...] synthesized from the VALUES exprs for pk cols
			const parts = meta.pkCols.map((c) => {
				const idx = cols.indexOf(c);
				if (idx < 0)
					throw new SqlDialectError(`composite pk col ${c} missing from INSERT into ${tbl}`);
				return vals[idx];
			});
			idExpr = ['[', ...parts.flatMap((p, k) => (k > 0 ? [',', ...p] : [...p])), ']'];
		} else if (!hasId && meta.pk === 'text') {
			// record id = pk col value so ON CONFLICT hits the record key
			const idx = cols.indexOf(meta.pkCols[0]);
			if (idx < 0)
				throw new SqlDialectError(`pk col ${meta.pkCols[0]} missing from INSERT into ${tbl}`);
			idExpr = vals[idx];
		} else if (!hasId) {
			idExpr = [seqVar];
		}

		const finalCols = idExpr ? ['id', ...cols] : cols;
		const finalVals = idExpr ? [idExpr, ...vals] : vals;

		// find RETURNING / ON CONFLICT after rowEnd
		const tail = rewriteRange(rowEnd + 1, toks.length);

		const pre: string[] = [];
		if (!hasId && meta.pk !== 'composite' && meta.pk !== 'text') {
			pre.push(`LET ${seqVar} = (UPSERT seq:⟨${tbl}⟩ SET v += 1 RETURN VALUE v)[0];`);
		}

		const stmt: (Tok | string)[] = [
			...head,
			`(${finalCols.map((c) => (RESERVED.has(c) ? `\`${c}\`` : c)).join(', ')})`,
			'VALUES',
			`(${finalVals.map((v) => render(v)).join(', ')})`
		];

		// RETURNING handling inside tail: rewriteRange already emitted raw
		// tokens; handle here instead by scanning tail for RETURNING.
		let tailOut = tail;
		const rIdx = tailOut.findIndex((t) => typeof t !== 'string' && isWord(t, 'RETURNING'));
		if (rIdx >= 0) {
			const after = tailOut.slice(rIdx + 1);
			const isStar = after.length === 1 && typeof after[0] !== 'string' && after[0].v === '*';
			const isId = after.length === 1 && typeof after[0] !== 'string' && after[0].v === 'id';
			if (isStar) tailOut = [...tailOut.slice(0, rIdx), 'RETURN', 'AFTER'];
			else if (isId) tailOut = [...tailOut.slice(0, rIdx), 'RETURN', 'VALUE', 'id'];
			else tailOut = [...tailOut.slice(0, rIdx), 'RETURN', ...after];
		} else {
			// no RETURNING: emit RETURN VALUE id so run() gets lastInsertRowid
			tailOut = [...tailOut, 'RETURN', 'VALUE', 'id'];
			returnsId = true;
		}

		return { surql: pre.join('') + render([...stmt, ...tailOut]), returnsId };
	}

	if (first === 'SELECT' && !toks.some((t) => isWord(t, 'FROM')))
		throw new SqlDialectError('bare SELECT needs FROM; use a table or RETURN');

	// RETURNING for UPDATE/DELETE and remaining rewrites
	const body = rewriteRange(0, toks.length);

	// SurrealQL has no BETWEEN: x BETWEEN lo AND hi -> (x >= lo AND x <= hi)
	for (let k = 0; k < body.length; k++) {
		const t = body[k];
		if (typeof t === 'string' || !isWord(t, 'BETWEEN')) continue;
		// left operand: walk back over a dotted column ref
		let ls = k - 1;
		while (ls > 0) {
			const prev = body[ls - 1];
			if (typeof prev === 'string' || prev.t !== 'punct' || prev.v !== '.') break;
			ls -= 2;
		}
		// params already rendered as $pN strings; literals stay Toks
		const lo = body.at(k + 1);
		const andTok = body.at(k + 2);
		const hi = body.at(k + 3);
		const operand = body.slice(ls, k);
		const lastOp = operand.at(-1);
		if (
			ls < 0 ||
			lo === undefined ||
			hi === undefined ||
			typeof andTok === 'string' ||
			!isWord(andTok, 'AND') ||
			operand.length === 0 ||
			(typeof lastOp !== 'string' && isWord(lastOp, 'NOT'))
		) {
			throw new SqlDialectError('unsupported BETWEEN form');
		}
		body.splice(
			ls,
			k + 4 - ls,
			punct('(', 0),
			...operand,
			op('>='),
			lo,
			'AND',
			...operand,
			op('<='),
			hi,
			punct(')', 0)
		);
		k = ls;
	}

	// fold shadow cols on UPDATE t SET col = expr
	if (first === 'UPDATE') {
		const tbl = tableAt.get(0);
		const folds = tbl ? (tables.get(tbl)?.folds ?? {}) : {};
		const whereIdx = body.findIndex(
			(t) => typeof t !== 'string' && isWord(t, 'WHERE') && t.depth === 0
		);
		const setEnd = whereIdx >= 0 ? whereIdx : body.length;
		const adds: (Tok | string)[] = [];
		for (const [col, shadow] of Object.entries(folds)) {
			for (let k = 0; k < setEnd - 2; k++) {
				const a = body[k];
				const b = body[k + 1];
				if (
					typeof a !== 'string' &&
					a.t === 'word' &&
					a.v === col &&
					typeof b !== 'string' &&
					b.v === '='
				) {
					// expr runs to next depth-0 comma or setEnd
					let e = k + 2;
					while (e < setEnd) {
						const t = body[e];
						if (t === ',' || (typeof t !== 'string' && t.v === ',' && t.depth === 0)) break;
						e++;
					}
					adds.push(
						',',
						word(shadow),
						op('='),
						'string::lowercase',
						punct('(', 0),
						...body.slice(k + 2, e),
						punct(')', 0)
					);
					break;
				}
			}
		}
		if (adds.length) body.splice(setEnd, 0, ...adds);
	}

	const rIdx = body.findIndex((t) => typeof t !== 'string' && isWord(t, 'RETURNING'));
	if (rIdx < 0 && first === 'DELETE') {
		// SurrealDB DELETE returns nothing by default; RETURN BEFORE
		// gives affected rows for the .changes contract
		body.push('RETURN', 'BEFORE');
	}
	if (rIdx >= 0 && (first === 'UPDATE' || first === 'DELETE' || first === 'SELECT')) {
		const after = body.slice(rIdx + 1);
		const isStar = after.length === 1 && typeof after[0] !== 'string' && after[0].v === '*';
		if (isStar) {
			body.splice(rIdx, body.length - rIdx, 'RETURN', first === 'DELETE' ? 'BEFORE' : 'AFTER');
		} else if (after.length === 1 && typeof after[0] !== 'string' && after[0].v === 'id') {
			body.splice(rIdx, body.length - rIdx, 'RETURN', 'VALUE', 'id');
		} else {
			body.splice(rIdx, body.length - rIdx, 'RETURN', ...after);
		}
	}

	// OFFSET -> START (outside LIMIT handled by SurrealQL START)
	for (let k = 0; k < body.length; k++) {
		const t = body[k];
		if (typeof t !== 'string' && isWord(t, 'OFFSET')) body[k] = 'START';
		if (typeof t !== 'string' && isWord(t, 'NULL')) body[k] = 'NONE';
	}

	// bare aggregates need GROUP ALL in SurrealQL
	if (first === 'SELECT') {
		const hasGroup = body.some((t, i) => {
			const next = body.at(i + 1);
			return (
				typeof t !== 'string' &&
				isWord(t, 'GROUP') &&
				typeof next !== 'string' &&
				isWord(next, 'BY')
			);
		});
		const fromIdx = body.findIndex((t) => typeof t !== 'string' && isWord(t, 'FROM'));
		const hasAgg = body.slice(0, fromIdx < 0 ? undefined : fromIdx).some((t) => {
			const v = typeof t === 'string' ? t : t.v;
			return (
				v === 'count()' ||
				v === 'count' ||
				v.startsWith('math::sum') ||
				v.startsWith('math::mean') ||
				v.startsWith('math::min') ||
				v.startsWith('math::max')
			);
		});
		if (hasAgg && !hasGroup) {
			// GROUP ALL goes after WHERE, before ORDER BY/LIMIT
			let ins = body.length;
			for (let k = 0; k < body.length; k++) {
				const t = body[k];
				if (
					typeof t !== 'string' &&
					t.depth === 0 &&
					(isWord(t, 'ORDER') || isWord(t, 'LIMIT') || isWord(t, 'START'))
				) {
					ins = k;
					break;
				}
			}
			body.splice(ins, 0, 'GROUP', 'ALL');
		}
	}

	// SurrealDB requires every ORDER BY idiom in the projection; sqlite
	// does not. Append missing plain-column order fields after the
	// select list so ORDER BY id on SELECT hash keeps working.
	if (first === 'SELECT') {
		const orderIdx = body.findIndex(
			(t) => typeof t !== 'string' && isWord(t, 'ORDER') && t.depth === 0
		);
		const fromIdx = body.findIndex(
			(t) => typeof t !== 'string' && isWord(t, 'FROM') && t.depth === 0
		);
		const sel = fromIdx > 1 ? body.slice(1, fromIdx) : [];
		const isStar = sel.some((t) => typeof t !== 'string' && t.t === 'op' && t.v === '*');
		if (orderIdx > 0 && fromIdx > 1 && !isStar) {
			const selected = new Set<string>();
			for (const s of sel) if (typeof s !== 'string' && s.t === 'word') selected.add(s.v);
			const adds: (Tok | string)[] = [];
			for (let k = orderIdx + 1; k < body.length; k++) {
				const t = body[k];
				if (typeof t === 'string') break;
				if (t.depth !== 0) break;
				if (t.v === ',' || isWord(t, 'BY') || isWord(t, 'ASC') || isWord(t, 'DESC')) {
					continue;
				}
				if (
					isWord(t, 'LIMIT') ||
					isWord(t, 'START') ||
					isWord(t, 'GROUP') ||
					isWord(t, 'RETURN') ||
					isWord(t, 'FETCH')
				) {
					break;
				}
				if (t.t === 'word') {
					// dotted refs and expressions are left alone
					const next = body.at(k + 1);
					if (typeof next !== 'string' && next?.t === 'punct' && next.v === '.') break;
					if (!selected.has(t.v)) {
						adds.push(',', word(t.v));
						selected.add(t.v);
					}
					continue;
				}
				break;
			}
			if (adds.length) body.splice(fromIdx, 0, ...adds);
		}
	}

	return { surql: render(body), returnsId };
}
