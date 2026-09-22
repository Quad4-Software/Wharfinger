import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import webpush from 'web-push';
import type { VapidKeys } from 'web-push';
import { dataDir } from '$lib/server/store/db';
import {
	blockedHost,
	EGRESS_BLOCKED_DETAIL,
	type Egress,
	type FetchInit
} from '$lib/server/http/egress';
import type { PushSub } from '$lib/server/store/pushsubs';
import type { SendResult } from './senders';

// Web Push sender: RFC 8291 payload encryption plus VAPID (RFC 8292)
// request signing via web-push, then the actual POST goes through the
// shared egress dispatcher like every other outbound call, because
// subscription endpoints are user-supplied-externally URLs.

/**
 * VAPID identity, generated on first boot and persisted next to
 * secrets.key with owner-only permissions. The public key is handed
 * to browsers at subscribe time as applicationServerKey; the private
 * key only ever signs the JWT inside generateRequestDetails and is
 * never exposed in a route response.
 */
export function vapidKeys(dir = dataDir()): VapidKeys {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, 'vapid.json');
	let raw: string;
	try {
		raw = readFileSync(path, 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
		const keys = webpush.generateVAPIDKeys();
		try {
			// wx is O_EXCL: atomic create-or-fail, so a racing boot can
			// never clobber or redirect the identity file.
			writeFileSync(path, JSON.stringify(keys), { mode: 0o600, flag: 'wx' });
		} catch (werr) {
			if ((werr as NodeJS.ErrnoException).code !== 'EEXIST') throw werr;
		}
		try {
			chmodSync(path, 0o600);
		} catch {
			// best effort on filesystems without posix modes
		}
		raw = readFileSync(path, 'utf8');
	}
	const parsed = JSON.parse(raw) as Partial<VapidKeys>;
	if (typeof parsed.publicKey !== 'string' || typeof parsed.privateKey !== 'string') {
		throw new Error(`${path} is not a valid VAPID key file`);
	}
	return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
}

/**
 * VAPID subject contact URI: the configured site URL when it is https,
 * otherwise a placeholder mailto so the JWT stays well-formed.
 */
export function vapidSubject(siteUrl: string | null): string {
	if (siteUrl?.startsWith('https://')) return siteUrl;
	return 'mailto:wharfinger@localhost';
}

type PushUrgency = 'normal' | 'high';

export interface PushSendDeps {
	keys: VapidKeys;
	subject: string;
	urgency: PushUrgency;
	timeoutMs: number;
	egress: Egress;
}

/**
 * Send one encrypted push message to one subscription endpoint.
 * generateRequestDetails builds the VAPID JWT, TTL, and aes128gcm
 * body; the POST itself runs through egress so DNS is validated at
 * connect time and link-local endpoints are refused. The caller maps
 * 404/410 to a subscription tombstone.
 */
export async function sendPush(
	sub: PushSub,
	payload: string,
	deps: PushSendDeps
): Promise<SendResult> {
	try {
		if (!sub.p256dh || !sub.auth) {
			return { ok: false, status: null, error: 'subscription has no encryption keys' };
		}
		const host = new URL(sub.endpoint).hostname;
		if (!deps.egress.allowLinkLocal() && blockedHost(host)) {
			return { ok: false, status: null, error: EGRESS_BLOCKED_DETAIL };
		}
		const details = webpush.generateRequestDetails(
			{ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
			payload,
			{
				vapidDetails: {
					subject: deps.subject,
					publicKey: deps.keys.publicKey,
					privateKey: deps.keys.privateKey
				},
				TTL: 6 * 3600,
				urgency: deps.urgency
			}
		);
		const headers: Record<string, string> = {};
		for (const [k, v] of Object.entries(details.headers as Record<string, unknown>)) {
			// undici computes Content-Length from the body; forwarding
			// the library's copy risks a mismatch rejection. TTL and
			// Content-Length arrive as numbers despite the declared
			// string map, hence the String coercion.
			if (k.toLowerCase() === 'content-length') continue;
			headers[k] = String(v);
		}
		const res = await fetch(details.endpoint, {
			method: details.method,
			headers,
			body: details.body,
			signal: AbortSignal.timeout(deps.timeoutMs),
			redirect: 'manual',
			dispatcher: deps.egress.dispatcher
		} as FetchInit);
		// Drain so the connection can be reused; we never read the body.
		await res.arrayBuffer().catch(() => undefined);
		if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, error: null };
		return { ok: false, status: res.status, error: `HTTP ${res.status}` };
	} catch (err) {
		return { ok: false, status: null, error: err instanceof Error ? err.message : String(err) };
	}
}
