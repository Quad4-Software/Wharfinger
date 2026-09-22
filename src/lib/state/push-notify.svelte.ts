import { browser } from '$app/environment';

// Browser push + Notification API helper. push notifications ride the
// service worker (alerts arrive with the tab closed); notifyLocal is
// the in-tab counterpart for code that wants a system notification
// while the page is open.

const FLAG = 'wf-push-enabled';
const SUBSCRIBE_URL = '/api/push-subscribe';

export function pushSupported(): boolean {
	return (
		browser && 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window
	);
}

let permission = $state<NotificationPermission>(readPermission());
let enabled = $state(readFlag());

function readPermission(): NotificationPermission {
	return browser && 'Notification' in window ? Notification.permission : 'default';
}

function readFlag(): boolean {
	if (!browser) return false;
	try {
		return localStorage.getItem(FLAG) === '1';
	} catch {
		return false;
	}
}

export function pushPermission(): NotificationPermission {
	return permission;
}

/** True when this browser opted in and posted a subscription before. */
export function pushEnabled(): boolean {
	return enabled;
}

// VAPID public keys arrive base64url; subscribe() wants the raw bytes.
function urlBase64ToBytes(s: string): Uint8Array {
	const pad = '='.repeat((4 - (s.length % 4)) % 4);
	const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
	const out = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
	return out;
}

export type PushSetupResult = 'enabled' | 'denied' | 'unsupported' | 'error';

/**
 * Ask for notification permission, register the service worker, and
 * create + post a push subscription. Returns the resulting state so
 * the caller can render blocked/unsupported without a second guess.
 */
export async function requestPushPermission(): Promise<PushSetupResult> {
	if (!pushSupported()) return 'unsupported';
	permission = await Notification.requestPermission();
	if (permission !== 'granted') {
		enabled = false;
		return 'denied';
	}
	try {
		const reg = await navigator.serviceWorker.register('/service-worker.js');
		const info = (await (await fetch(SUBSCRIBE_URL)).json()) as {
			vapidPublicKey?: string;
		};
		if (typeof info.vapidPublicKey !== 'string') return 'error';
		const sub = await reg.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: urlBase64ToBytes(info.vapidPublicKey) as BufferSource
		});
		if (!(await postSubscription(sub))) return 'error';
		try {
			localStorage.setItem(FLAG, '1');
		} catch {
			// storage unavailable; the subscription is still live
		}
		enabled = true;
		return 'enabled';
	} catch {
		return 'error';
	}
}

async function postSubscription(sub: PushSubscription): Promise<boolean> {
	const json = sub.toJSON();
	const res = await fetch(SUBSCRIBE_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			endpoint: json.endpoint,
			keys: json.keys,
			userAgent: navigator.userAgent
		})
	});
	return res.ok;
}

/**
 * Re-post the live subscription so last_seen_at stays fresh and the
 * row survives the stale-subscription prune. No-op unless this browser
 * previously opted in.
 */
export async function syncPushSubscription(): Promise<void> {
	if (!pushSupported() || !readFlag() || Notification.permission !== 'granted') return;
	try {
		const reg = await navigator.serviceWorker.getRegistration();
		const sub = await reg?.pushManager.getSubscription();
		if (sub) await postSubscription(sub);
	} catch {
		// sync is best-effort; the next opt-in recreates the row
	}
}

/** Unsubscribe this browser and remove the server-side row. */
export async function unsubscribePush(): Promise<void> {
	if (pushSupported()) {
		try {
			const reg = await navigator.serviceWorker.getRegistration();
			const sub = await reg?.pushManager.getSubscription();
			if (sub) {
				await fetch(SUBSCRIBE_URL, {
					method: 'DELETE',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ endpoint: sub.endpoint })
				}).catch(() => undefined);
				await sub.unsubscribe().catch(() => undefined);
			}
		} catch {
			// best-effort teardown
		}
	}
	try {
		localStorage.removeItem(FLAG);
	} catch {
		// storage unavailable
	}
	enabled = false;
}

/**
 * In-tab notification via the Notification API, for events observed
 * while the page is open (SSE updates, chat pings). Returns false when
 * the browser cannot or may not notify.
 */
export function notifyLocal(title: string, body: string): boolean {
	if (!pushSupported() || Notification.permission !== 'granted') return false;
	new Notification(title, { body, icon: '/favicon.svg' });
	return true;
}
