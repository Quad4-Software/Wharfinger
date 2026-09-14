#!/usr/bin/env node
// Test-type consistency gate. Every src/lib/server module with logic
// must be imported by at least one unit test, and every admin/api
// route must appear in a test. Exemptions live in the manifest with
// a reason; the manifest may only shrink.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

// Modules that legitimately have no unit test today. Shrink-only;
// add a test and remove the entry.
const EXEMPTIONS = new Map([
	['src/lib/server/admin/chat-bus.ts', 'in-process ws fanout shim; covered via chat tests'],
	['src/lib/server/admin/config-actions.ts', 'covered transitively via config-overrides tests'],
	['src/lib/server/apikey.ts', 'needs dedicated scope/lookup tests'],
	['src/lib/server/ingress/view.ts', 'needs view-shaping tests'],
	['src/lib/server/runtime.ts', 'composition root; covered transitively by feature tests'],
	['src/lib/server/sse.ts', 'needs sse hub tests'],
	['src/lib/server/store/checks.ts', 'needs store tests'],
	['src/lib/server/store/incidents.ts', 'needs store tests'],
	['src/lib/server/telemetry.ts', 'outbound reporter; covered via telemetry store tests']
]);

// Server modules that are pure re-export barrels or type-only: no
// logic to test, never flagged.
const TYPE_ONLY = /export type|^import type/gm;

function* walk(dir, ext) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) yield* walk(p, ext);
		else if (name.endsWith(ext)) yield p;
	}
}

// Reverse index: which source modules each test file references.
const testFiles = [
	...walk(join(ROOT, 'tests', 'unit'), '.test.ts'),
	...walk(join(ROOT, 'tests', 'component'), '.test.ts')
];
const covered = new Set();
for (const t of testFiles) {
	const text = readFileSync(t, 'utf8');
	for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]/g)) {
		covered.add(m[1] ?? m[2]);
	}
	// Route tests import the generated $types-relative server file.
	for (const m of text.matchAll(/routes\/([^'"]+)\/\+server/g)) {
		covered.add(`route:${m[1]}`);
	}
}

let failures = 0;
const serverFiles = [...walk(join(ROOT, 'src/lib/server'), '.ts')].map((f) => relative(ROOT, f));
for (const file of serverFiles) {
	const text = readFileSync(join(ROOT, file), 'utf8');
	const withoutTypes = text.replace(TYPE_ONLY, '');
	if (withoutTypes.trim().length < 40) continue; // type-only module
	const stem = file.replace(/\.ts$/, '');
	const hit = [...covered].some(
		(spec) => spec.includes('server') && (spec.endsWith(stem) || spec.endsWith(basename(stem)))
	);
	if (!hit && !EXEMPTIONS.has(file)) {
		console.error(`FAIL (no unit test imports it): ${file}`);
		failures++;
	}
}

// Route coverage is a warning class today: many routes are thin and
// covered transitively. New routes should still add tests; this
// reports rather than fails until the backlog clears.
let routeWarnings = 0;
for (const f of walk(join(ROOT, 'src/routes/admin/api'), '+server.ts')) {
	const rel = relative(ROOT, f)
		.replace(/^src\/routes\//, '')
		.replace(/\/\+server\.ts$/, '');
	if (!covered.has(`route:${rel}`)) routeWarnings++;
}
if (routeWarnings) console.warn(`${routeWarnings} admin/api route(s) without a direct route test`);

if (failures) {
	console.error(`${failures} server module(s) lack unit tests. See .agents/rules/testing.md.`);
	process.exit(1);
}
console.log('check:tests ok');
