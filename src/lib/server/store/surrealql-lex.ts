// Lexer and renderer for the SQLite-to-SurrealQL translator in
// surrealql.ts. Tokens carry paren depth so clause rewrites can tell
// top-level keywords from nested expression text.

type TokType = 'word' | 'num' | 'str' | 'param' | 'punct' | 'op';

export interface Tok {
	t: TokType;
	v: string;
	depth: number;
}

const PUNCT = new Set(['(', ')', ',', ';', '.']);
const OPS = new Set(['=', '<', '>', '!', '|', '+', '-', '*', '/', '%', ':']);

// Identifiers that collide with SurrealQL keywords and need quoting.
export const RESERVED = new Set(['key', 'value', 'type', 'content', 'range', 'in', 'out', 'with']);

export function tokenize(sql: string): Tok[] {
	const out: Tok[] = [];
	let depth = 0;
	let i = 0;
	const n = sql.length;
	while (i < n) {
		const c = sql[i];
		if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
			i++;
			continue;
		}
		if (c === '-' && sql[i + 1] === '-') {
			while (i < n && sql[i] !== '\n') i++;
			continue;
		}
		if (c === '/' && sql[i + 1] === '*') {
			i += 2;
			while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
			i += 2;
			continue;
		}
		if (c === "'") {
			let j = i + 1;
			while (j < n && sql[j] !== "'") j++;
			if (sql[j + 1] === "'") {
				// '' escape: keep scanning
				j++;
				while (j < n && sql[j] !== "'") j++;
			}
			out.push({ t: 'str', v: sql.slice(i, j + 1), depth });
			i = j + 1;
			continue;
		}
		if (c === '"' || c === '`') {
			const end = c;
			let j = i + 1;
			while (j < n && sql[j] !== end) j++;
			out.push({ t: 'word', v: sql.slice(i + 1, j), depth });
			i = j + 1;
			continue;
		}
		if (c === '?') {
			out.push({ t: 'param', v: '?', depth });
			i++;
			continue;
		}
		if (c === '(') {
			out.push({ t: 'punct', v: '(', depth });
			depth++;
			i++;
			continue;
		}
		if (c === ')') {
			depth--;
			out.push({ t: 'punct', v: ')', depth });
			i++;
			continue;
		}
		if (PUNCT.has(c)) {
			out.push({ t: 'punct', v: c, depth });
			i++;
			continue;
		}
		if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
			let j = i;
			while (j < n && /[0-9a-fA-FxXeE._]/.test(sql[j])) j++;
			out.push({ t: 'num', v: sql.slice(i, j), depth });
			i = j;
			continue;
		}
		if (/[A-Za-z_@$]/.test(c)) {
			let j = i;
			while (j < n && /[A-Za-z0-9_@$.]/.test(sql[j])) j++;
			out.push({ t: 'word', v: sql.slice(i, j), depth });
			i = j;
			continue;
		}
		if (OPS.has(c)) {
			let v = c;
			const two = sql.slice(i, i + 2);
			if (
				two === '!=' ||
				two === '<>' ||
				two === '<=' ||
				two === '>=' ||
				two === '||' ||
				two === '??'
			) {
				v = two;
				i += 2;
			} else {
				i++;
			}
			out.push({ t: 'op', v, depth });
			continue;
		}
		i++;
	}
	return out;
}

export const isWord = (t: Tok | undefined, ...ws: string[]) =>
	t?.t === 'word' && ws.includes(t.v.toUpperCase());

export function render(toks: (Tok | string)[]): string {
	let out = '';
	for (const t of toks) {
		const v = typeof t === 'string' ? t : t.v;
		if (out === '') {
			out = v;
			continue;
		}
		const prev = out[out.length - 1];
		if (
			v === ',' ||
			v === ')' ||
			v === ']' ||
			v === ';' ||
			v === '.' ||
			prev === '(' ||
			prev === '[' ||
			prev === '.'
		) {
			out += v;
		} else if (v === '(') {
			// attach to lowercase function names (math::sum) but not keywords
			out += /[a-z:]/.test(prev) ? v : ' ' + v;
		} else {
			out += ' ' + v;
		}
	}
	return out;
}
