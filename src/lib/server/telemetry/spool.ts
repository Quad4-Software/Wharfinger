import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENVELOPE_MAX_BYTES } from './ingest';

// Durable on-disk spool for telemetry queue mode. One file per
// envelope under <data>/telemetry-spool/, named
// <ts>-<seq>-p<projectId>-<rand>-<eventId?>.envelope so lexicographic
// order is arrival order (seq breaks same-ms ties) and the project id
// travels with the file (the flush path no longer has the request's
// project context). Writes go through a tmp file plus rename so a
// crash never leaves a half-written envelope; init() sweeps the
// leftovers.
//
// Overflow policy is reject-newest: enqueue() answers 'full' once the
// cap is hit and the route turns that into a 429, so clients see
// backpressure instead of silent loss.

const FILE_RE = /^(\d+)-(\d+)-p(\d+)-([a-zA-Z0-9][a-zA-Z0-9_-]{0,95})\.envelope$/;
const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export interface SpoolEntry {
	projectId: number;
	body: Uint8Array;
}

// 'ok' consumes the file, 'drop' deletes it as poison, 'retry' keeps
// it and stops the drain so ordering survives a store outage.
export type SpoolVerdict = 'ok' | 'drop' | 'retry';
export type SpoolSink = (entry: SpoolEntry) => Promise<SpoolVerdict>;

export class EnvelopeSpool {
	readonly dir: string;
	// Monotonic suffix so same-ms enqueues keep arrival order.
	private seq = 0;

	constructor(dir: string) {
		this.dir = dir;
	}

	/** Create the dir and sweep crash leftovers and foreign files. */
	init(): void {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		for (const name of this.names()) {
			if (!FILE_RE.test(name)) rmSync(join(this.dir, name), { force: true });
		}
	}

	private names(): string[] {
		try {
			return readdirSync(this.dir).sort();
		} catch {
			return [];
		}
	}

	/** Spooled envelope files, oldest first. */
	files(): string[] {
		return this.names().filter((n) => FILE_RE.test(n));
	}

	get size(): number {
		return this.files().length;
	}

	/**
	 * Append one envelope. The caller passes the configured cap so a
	 * config reload applies without rebuilding the spool.
	 */
	enqueue(
		projectId: number,
		eventId: string | null,
		body: Uint8Array,
		maxFiles: number
	): 'ok' | 'full' {
		if (this.size >= maxFiles) return 'full';
		const slug = eventId !== null && SLUG_RE.test(eventId) ? eventId.slice(0, 40) : null;
		const name = `${Date.now()}-${String(this.seq++).padStart(8, '0')}-p${projectId}-${randomBytes(4).toString('hex')}${slug === null ? '' : `-${slug}`}.envelope`;
		const tmp = join(this.dir, `.${name}.tmp`);
		writeFileSync(tmp, body);
		renameSync(tmp, join(this.dir, name));
		return 'ok';
	}

	/**
	 * Feed up to limit files through the sink, oldest first. Consumed
	 * and poisoned files are deleted; a 'retry' verdict stops the
	 * drain with the file left in place for the next tick. Returns
	 * the number of files consumed.
	 */
	async drain(limit: number, sink: SpoolSink): Promise<number> {
		let done = 0;
		for (const name of this.files()) {
			if (done >= limit) break;
			const path = join(this.dir, name);
			const m = FILE_RE.exec(name);
			if (m === null) continue;
			let body: Uint8Array;
			try {
				body = readFileSync(path);
			} catch {
				rmSync(path, { force: true });
				continue;
			}
			// Oversized or empty files can only come from tampering or
			// an interrupted rename; drop them rather than stalling.
			if (body.length === 0 || body.length > ENVELOPE_MAX_BYTES) {
				rmSync(path, { force: true });
				continue;
			}
			const verdict = await sink({ projectId: Number(m[3]), body });
			if (verdict === 'retry') break;
			rmSync(path, { force: true });
			done++;
		}
		return done;
	}
}
