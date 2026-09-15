import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '$lib/server/store/db';
import { AgentReleaseStore } from '$lib/server/agent-release';

// Hub-hosted release binaries: manifest shape, sha256 integrity, and
// name/version validation that keeps uploads inside the data dir.

let dir: string;
let store: AgentReleaseStore;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'wharfinger-rel-'));
	store = new AgentReleaseStore(openDb(dir), dir);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('AgentReleaseStore', () => {
	it('rejects unsafe names and versions', () => {
		expect(AgentReleaseStore.validName('wharfinger-agent-linux-amd64')).toBe(true);
		expect(AgentReleaseStore.validName('../x')).toBe(false);
		expect(AgentReleaseStore.validName('a/b')).toBe(false);
		expect(AgentReleaseStore.validName('')).toBe(false);
		expect(AgentReleaseStore.validVersion('0.2.0')).toBe(true);
		expect(AgentReleaseStore.validVersion('v0.2.0')).toBe(true);
		expect(AgentReleaseStore.validVersion('latest')).toBe(false);
	});

	it('stores binaries with a server-side sha256', async () => {
		const body = new TextEncoder().encode('fake agent binary');
		const row = await store.put('wharfinger-agent-linux-amd64', '0.2.0', body);
		expect(row.sha256).toBe(sha(body));
		expect(
			Buffer.compare(Buffer.from(store.read('wharfinger-agent-linux-amd64')!), Buffer.from(body))
		).toBe(0);
	});

	it('manifest reports the newest version across files', async () => {
		await store.put('wharfinger-agent-linux-amd64', '0.2.0', new Uint8Array([1]));
		await store.put('wharfinger-agent-linux-arm64', '0.10.0', new Uint8Array([2]));
		const m = await store.manifest();
		expect(m?.version).toBe('0.10.0');
		expect(m?.files).toHaveLength(2);
		expect(m?.files[0].url).toContain('/api/agent-release/files/');
	});

	it('re-upload replaces the binary and digest', async () => {
		await store.put('wharfinger-agent-linux-amd64', '0.2.0', new Uint8Array([1]));
		const row = await store.put('wharfinger-agent-linux-amd64', '0.3.0', new Uint8Array([9]));
		expect(row.sha256).toBe(sha(new Uint8Array([9])));
		expect(await store.list()).toHaveLength(1);
		expect([...(store.read('wharfinger-agent-linux-amd64') ?? [])]).toEqual([9]);
	});

	it('remove deletes the row and file; empty store has no manifest', async () => {
		expect(await store.manifest()).toBeNull();
		await store.put('wharfinger-agent-linux-amd64', '0.2.0', new Uint8Array([1]));
		expect(await store.remove('wharfinger-agent-linux-amd64')).toBe(true);
		expect(store.read('wharfinger-agent-linux-amd64')).toBeNull();
		expect(await store.remove('wharfinger-agent-linux-amd64')).toBe(false);
		expect(store.read('../wharfinger.db')).toBeNull();
	});
});
