import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { Runtime } from '$lib/server/runtime';
import type { User } from '$lib/server/admin/users';
import { openDb } from '$lib/server/store/db';
import { ConfigStore } from '$lib/server/config/store';
import { resolveEffective, type EffectiveConfig } from '$lib/server/config/effective';
import { loadRawConfig } from '$lib/server/config/load';
import { applyTomlDocument, stripTomlUnfriendly } from '$lib/server/admin/config-doc';
import { SectionError } from '$lib/server/admin/config-actions';
import type { Permission } from '$lib/server/admin/authz';

const MINIMAL = `
[site]
name = "Test Co"

[[services]]
id = "web"
name = "Web"
type = "http"
url = "https://example.com"
`;

const actor = { id: 1, username: 'root' } as User;
const MANAGE: ReadonlySet<Permission> = new Set(['status.manage']);

function freshDb(): DatabaseSync {
	return openDb(mkdtempSync(join(tmpdir(), 'wharfinger-cfgdb-')));
}

function fileOf(toml: string): string {
	const dir = mkdtempSync(join(tmpdir(), 'wharfinger-cfg-'));
	const p = join(dir, 'wharfinger.toml');
	writeFileSync(p, toml);
	return p;
}

interface FakeRt {
	rt: Runtime;
	store: ConfigStore;
	audits: { action: string }[];
	reload: () => Promise<void>;
}

async function fakeRuntime(toml = MINIMAL): Promise<FakeRt> {
	const path = fileOf(toml);
	const store = new ConfigStore(freshDb());
	const audits: { action: string }[] = [];
	let eff: EffectiveConfig = await resolveEffective(loadRawConfig(path), store);
	const rt = {
		effective: () => eff,
		configStore: store,
		reloadConfig: async () => {
			eff = await resolveEffective(loadRawConfig(path), store);
		},
		audit: {
			log: (e: { action: string }) => {
				audits.push(e);
				return Promise.resolve();
			}
		}
	} as unknown as Runtime;
	return { rt, store, audits, reload: () => rt.reloadConfig() };
}

describe('applyTomlDocument', () => {
	it('stores changed sections as overrides and records a revision', async () => {
		const { rt, store, audits } = await fakeRuntime();
		const doc = MINIMAL.replace('name = "Test Co"', 'name = "Edited Co"');
		const r = await applyTomlDocument(rt, actor, MANAGE, '127.0.0.1', doc);
		expect(r.overrides).toEqual(['site']);
		expect((await store.get('site'))?.raw).toEqual({ name: 'Edited Co' });
		const revs = await store.revisions();
		expect(revs).toHaveLength(1);
		expect(revs[0].author).toBe('root');
		expect(audits.map((a) => a.action)).toEqual(['config.toml.save']);
	});

	it('clears overrides when the document matches the file again', async () => {
		const { rt, store } = await fakeRuntime();
		await applyTomlDocument(
			rt,
			actor,
			MANAGE,
			'127.0.0.1',
			MINIMAL.replace('name = "Test Co"', 'name = "Edited Co"')
		);
		expect(await store.get('site')).not.toBeNull();
		const r = await applyTomlDocument(rt, actor, MANAGE, '127.0.0.1', MINIMAL);
		expect(r.overrides).toEqual([]);
		expect(await store.get('site')).toBeNull();
		expect(await store.revisions()).toHaveLength(2);
	});

	it('rejects malformed TOML with a 422', async () => {
		const { rt } = await fakeRuntime();
		await expect(
			applyTomlDocument(rt, actor, MANAGE, '127.0.0.1', '[site\nbroken =')
		).rejects.toMatchObject({ status: 422 });
		await expect(applyTomlDocument(rt, actor, MANAGE, '127.0.0.1', '')).rejects.toBeInstanceOf(
			SectionError
		);
	});

	it('rejects a document that fails merged validation', async () => {
		const { rt } = await fakeRuntime();
		const doc = MINIMAL.replace('name = "Test Co"', 'name = 42');
		await expect(applyTomlDocument(rt, actor, MANAGE, '127.0.0.1', doc)).rejects.toMatchObject({
			status: 422
		});
	});

	it('rejects edits to protected sections without the permission', async () => {
		const { rt } = await fakeRuntime();
		const doc = `${MINIMAL}\n[admin]\nenabled = true\n`;
		await expect(applyTomlDocument(rt, actor, MANAGE, '127.0.0.1', doc)).rejects.toMatchObject({
			status: 403
		});
	});

	it('resolves file placeholders copied into an override', async () => {
		const { rt } = await fakeRuntime(
			MINIMAL.replace(
				'name = "Test Co"',
				'name = "Test Co"\nurl = "${WF_DOC_TEST_URL:-https://fallback.example.com}"'
			)
		);
		const doc = MINIMAL.replace(
			'name = "Test Co"',
			'name = "Edited Co"\nurl = "${WF_DOC_TEST_URL:-https://fallback.example.com}"'
		);
		const r = await applyTomlDocument(rt, actor, MANAGE, '127.0.0.1', doc);
		expect(r.overrides).toEqual(['site']);
	});
});

describe('stripTomlUnfriendly', () => {
	it('drops undefined object values and nulls bare undefined', () => {
		expect(stripTomlUnfriendly(undefined)).toBeNull();
		expect(stripTomlUnfriendly({ a: 1, b: undefined })).toEqual({ a: 1 });
		expect(stripTomlUnfriendly([undefined, 2])).toEqual([null, 2]);
	});
});
