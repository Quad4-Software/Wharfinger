#!/usr/bin/env node
// No-god-files gate. Enforces line ceilings per file type so modules
// stay single-concern. The exception list below is the shrink-only
// backlog: entries may be removed (after a split) but never added to
// without a comment justifying why the file cannot be split.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

const CEILINGS = [
	{ match: /src\/lib\/server\/.*\.ts$/, max: 800, kind: 'server module' },
	{ match: /src\/lib\/.*\.ts$/, max: 800, kind: 'lib module' },
	{ match: /\.svelte$/, max: 700, kind: 'component/page' },
	{ match: /src\/routes\/.*\.ts$/, max: 500, kind: 'route' },
	{ match: /server\/.*\.mjs$/, max: 500, kind: 'bridge' },
	{ match: /agent\/.*\.go$/, max: 800, kind: 'go module' }
];

// Files over their ceiling today. Shrink-only: split per
// .agents/skills/safe-breakdown and delete the entry.
const EXCEPTIONS = new Map([
	['src/lib/server/monitor/checkers.ts', 'single registry; split per-checker pending'],
	['src/lib/server/config/schema.ts', 'schema declarations; split per-domain pending'],
	[
		'src/lib/components/admin/ServiceEditor.svelte',
		'editor; extract per-type field groups pending'
	],
	['src/routes/admin/(panel)/account/+page.svelte', 'extract passkey/session sections pending'],
	['src/routes/admin/(panel)/agents/[id]/+page.svelte', 'extract per-collector cards pending'],
	['src/routes/admin/(panel)/chat/+page.svelte', 'chat page; extract thread/composer pending'],
	['src/routes/admin/(panel)/settings/+page.svelte', 'extract per-section editors pending'],
	['src/routes/admin/(panel)/telemetry/+page.svelte', 'extract issue detail/trace views pending'],
	['src/routes/admin/(panel)/users/+page.svelte', 'extract role editor + modals pending']
]);

const SKIP_DIRS = new Set(['node_modules', '.svelte-kit', 'build', 'dist', '.git', 'coverage']);

function* walk(dir) {
	for (const name of readdirSync(dir)) {
		if (SKIP_DIRS.has(name)) continue;
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) yield* walk(p);
		else yield p;
	}
}

let failures = 0;
for (const dir of ['src', 'server', 'agent']) {
	for (const file of walk(join(ROOT, dir))) {
		const rel = relative(ROOT, file);
		const lines = readFileSync(file, 'utf8').split('\n').length - 1;
		const hit = CEILINGS.find(({ match }) => match.test(rel));
		if (!hit || lines <= hit.max) continue;
		const why = EXCEPTIONS.get(rel);
		if (why) {
			console.warn(`over (${hit.kind}, grandfathered): ${rel} ${lines}/${hit.max} - ${why}`);
		} else {
			console.error(`FAIL (${hit.kind} ceiling ${hit.max}): ${rel} has ${lines} lines`);
			failures++;
		}
	}
}
if (failures) {
	console.error(
		`${failures} file(s) over the size ceiling. Split per .agents/skills/safe-breakdown.`
	);
	process.exit(1);
}
console.log('check:files ok');
