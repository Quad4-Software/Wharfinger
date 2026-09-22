#!/usr/bin/env node
// i18n catalog gate. en is the source of truth. Three reports:
//   error   t('key') used in src but absent from en (exit 1)
//   warning en keys missing from another locale (they fall back)
//   warning en keys never referenced anywhere in src (unused)
// Plural variants count toward their base: using cert.expires covers
// cert.expires_one/_other, and an unused base hides unused variants.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const LOCALES_DIR = join(ROOT, 'src/lib/i18n/locales');
const PLURAL_SUFFIXES = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
const SKIP_DIRS = new Set(['node_modules', '.svelte-kit', 'build', 'dist', '.git', 'coverage']);

function* walk(dir) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) {
			if (!SKIP_DIRS.has(name)) yield* walk(p);
		} else {
			yield p;
		}
	}
}

// Catalog keys are quoted flat strings: 'status.skip': 'text'
function catalogKeys(file) {
	const keys = new Set();
	for (const m of readFileSync(file, 'utf8').matchAll(
		/^\s*'([a-z0-9_]+(?:\.[a-z0-9_]+)+)'\s*:/gm
	)) {
		keys.add(m[1]);
	}
	return keys;
}

function pluralBase(key) {
	const i = key.lastIndexOf('_');
	if (i < 0) return null;
	return PLURAL_SUFFIXES.has(key.slice(i + 1)) ? key.slice(0, i) : null;
}

const catalogs = new Map();
for (const f of readdirSync(LOCALES_DIR)) {
	if (!f.endsWith('.ts') || f.endsWith('.d.ts')) continue;
	catalogs.set(f.replace(/\.ts$/, ''), catalogKeys(join(LOCALES_DIR, f)));
}
const enKeys = catalogs.get('en');
if (!enKeys || enKeys.size === 0) {
	console.error('FAIL: en catalog missing or empty at src/lib/i18n/locales/en.ts');
	process.exit(1);
}

// A key is covered in en when it exists verbatim or a plural variant
// of it does.
function inEn(key) {
	if (enKeys.has(key)) return true;
	return [...PLURAL_SUFFIXES].some((s) => enKeys.has(`${key}_${s}`));
}

// Scan src for literal t('key') args plus any quoted string that
// matches an en key exactly (key maps like STATUS_KEYS hold literals
// outside t() calls).
const used = new Set();
const literals = new Set();
for (const f of walk(join(ROOT, 'src'))) {
	if (!/\.(svelte|ts)$/.test(f)) continue;
	if (f.includes('/i18n/locales/')) continue;
	const text = readFileSync(f, 'utf8');
	for (const m of text.matchAll(/\bt\(\s*'([^']+)'/g)) used.add(m[1]);
	for (const m of text.matchAll(/'([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)'/g)) literals.add(m[1]);
}

let failures = 0;
for (const key of used) {
	if (!inEn(key)) {
		console.error(`FAIL (used but missing from en): ${key}`);
		failures++;
	}
}

for (const [name, keys] of catalogs) {
	if (name === 'en') continue;
	const missing = [...enKeys].filter((k) => !keys.has(k));
	const extra = [...keys].filter((k) => !enKeys.has(k));
	if (missing.length)
		console.warn(`warn: ${name} missing ${missing.length} key(s): ${missing.join(', ')}`);
	if (extra.length)
		console.warn(`warn: ${name} has ${extra.length} key(s) not in en: ${extra.join(', ')}`);
}

const unused = [...enKeys].filter((k) => {
	if (literals.has(k) || used.has(k)) return false;
	const base = pluralBase(k);
	return base === null || (!literals.has(base) && !used.has(base));
});
if (unused.length) console.warn(`warn: ${unused.length} unused en key(s): ${unused.join(', ')}`);

if (failures) {
	console.error(`${failures} key(s) used in src are missing from the en catalog`);
	process.exit(1);
}
console.log(`check:i18n ok (${enKeys.size} en keys, ${catalogs.size - 1} other locale(s))`);
