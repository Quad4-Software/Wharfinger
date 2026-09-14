import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

// Hub-hosted agent binaries for air-gapped or firewalled fleets: an
// admin uploads release binaries once and agents pull the manifest +
// file from this hub instead of api.github.com. Binaries live on disk
// (too large for sqlite); metadata rows carry sha256 + version.
//
// Integrity: the agent pins the sha256 the manifest advertises, so a
// tampered file on the hub fails verification before install. Upload
// is agents.manage-gated; the manifest and files are public like any
// release asset.

export const RELEASE_FILE_MAX_BYTES = 64 * 1024 * 1024;
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const VERSION_RE = /^v?\d+\.\d+\.\d+(-[a-z0-9.]+)?$/i;

export interface ReleaseFile {
	name: string;
	version: string;
	sha256: string;
	size: number;
	uploadedAt: number;
}

export interface ReleaseManifest {
	version: string;
	files: { name: string; version: string; sha256: string; size: number; url: string }[];
}

export class AgentReleaseStore {
	private readonly dir: string;

	constructor(
		private readonly db: DatabaseSync,
		dataDir: string
	) {
		this.dir = join(dataDir, 'agent-releases');
	}

	static validName(name: string): boolean {
		return NAME_RE.test(name);
	}

	static validVersion(version: string): boolean {
		return VERSION_RE.test(version);
	}

	list(): ReleaseFile[] {
		return this.db
			.prepare(
				'SELECT name, version, sha256, size, uploaded_at AS uploadedAt FROM agent_release_files ORDER BY name'
			)
			.all() as unknown as ReleaseFile[];
	}

	/** Manifest for the newest uploaded version, or null when empty. */
	manifest(): ReleaseManifest | null {
		const files = this.list();
		if (files.length === 0) return null;
		const latest = files.map((f) => f.version).reduce((a, b) => (semverGt(b, a) ? b : a));
		return {
			version: latest,
			files: files.map((f) => ({
				name: f.name,
				version: f.version,
				sha256: f.sha256,
				size: f.size,
				url: `/api/agent-release/files/${encodeURIComponent(f.name)}`
			}))
		};
	}

	/** Store a binary. Returns the recorded metadata. */
	put(name: string, version: string, body: Uint8Array): ReleaseFile {
		mkdirSync(this.dir, { recursive: true });
		const sha256 = createHash('sha256').update(body).digest('hex');
		const tmp = join(this.dir, `.${name}.tmp`);
		writeFileSync(tmp, body);
		renameSync(tmp, join(this.dir, name));
		const row: ReleaseFile = { name, version, sha256, size: body.length, uploadedAt: Date.now() };
		this.db
			.prepare(
				`INSERT INTO agent_release_files (name, version, sha256, size, uploaded_at)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(name) DO UPDATE SET version = excluded.version,
				   sha256 = excluded.sha256, size = excluded.size,
				   uploaded_at = excluded.uploaded_at`
			)
			.run(name, version, sha256, body.length, row.uploadedAt);
		return row;
	}

	read(name: string): Uint8Array | null {
		if (!NAME_RE.test(name)) return null;
		try {
			return readFileSync(join(this.dir, name));
		} catch {
			return null;
		}
	}

	remove(name: string): boolean {
		const gone = this.db.prepare('DELETE FROM agent_release_files WHERE name = ?').run(name);
		if (NAME_RE.test(name)) {
			try {
				rmSync(join(this.dir, name));
			} catch {
				// Already gone from disk.
			}
		}
		return Number(gone.changes) > 0;
	}
}

/** Strict semver-ish compare on x.y.z (leading v tolerated). */
function semverGt(a: string, b: string): boolean {
	const pa = a.replace(/^v/, '').split('-')[0].split('.').map(Number);
	const pb = b.replace(/^v/, '').split('-')[0].split('.').map(Number);
	for (let i = 0; i < 3; i++) {
		const d = (pa[i] || 0) - (pb[i] || 0);
		if (d !== 0) return d > 0;
	}
	return false;
}
