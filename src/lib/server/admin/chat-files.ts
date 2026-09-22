import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

// On-disk layout and upload policy for chat attachments. Bytes live
// under <data>/chat-attachments/<room>/<id>[.<ext>]; the metadata row
// (chat_attachments.path) stores that relative key, so the disk key
// never carries a user-controlled name. Downloads always go out with
// content-disposition: attachment plus nosniff, so the mime allowlist
// is a courtesy filter, not a containment boundary.

export const CHAT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const CHAT_ATTACHMENT_MIMES: ReadonlySet<string> = new Set([
	'image/png',
	'image/jpeg',
	'image/gif',
	'image/webp',
	'text/plain',
	'text/markdown',
	'text/csv',
	'application/json',
	'application/pdf',
	'application/zip'
]);
const ATTACHMENT_NAME_MAX = 128;

/**
 * Display name only: the stored file is keyed by id, so this never
 * touches a path. Basename plus control-char strip keeps it safe to
 * render and to embed in a download header.
 */
export function cleanFilename(raw: string): string {
	const base = raw.split(/[\\/]/).pop() ?? '';
	// eslint-disable-next-line no-control-regex
	const stripped = base.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim();
	return (stripped || 'file').slice(0, ATTACHMENT_NAME_MAX);
}

/** Relative disk key '<room>/<id>[.<ext>]'; ext comes from the cleaned name. */
export function attachmentKey(roomId: string, id: string, name: string): string {
	const ext = /\.([A-Za-z0-9]{1,12})$/.exec(name)?.[1]?.toLowerCase() ?? '';
	return `${roomId}/${id}${ext ? `.${ext}` : ''}`;
}

/** Resolve a stored key under the attachments dir; null on traversal. */
export function attachmentPath(dir: string, key: string): string | null {
	const abs = resolve(dir, key);
	return abs.startsWith(dir + sep) ? abs : null;
}

/** Write through a temp name so a concurrent reader never sees a partial file. */
export function writeAttachment(dir: string, key: string, data: Uint8Array): void {
	const abs = attachmentPath(dir, key);
	if (abs === null) throw new Error('attachment key escaped the store dir');
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(`${abs}.tmp`, data);
	renameSync(`${abs}.tmp`, abs);
}

export function readAttachment(dir: string, key: string): Uint8Array | null {
	const abs = attachmentPath(dir, key);
	if (abs === null) return null;
	try {
		return readFileSync(abs);
	} catch {
		return null;
	}
}

/** Best-effort unlink for keys the purge sweep dropped. */
export function removeAttachments(dir: string, keys: string[]): void {
	for (const key of keys) {
		const abs = attachmentPath(dir, key);
		if (abs === null) continue;
		try {
			rmSync(abs);
		} catch {
			// Already gone from disk.
		}
	}
}
