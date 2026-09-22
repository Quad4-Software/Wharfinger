/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

// Push receiver only: no fetch handler, so the worker never
// intercepts page traffic. Payloads arrive from the notify
// dispatcher's webpush fanout as {title, body, url}.

const sw = self as unknown as ServiceWorkerGlobalScope;

interface PushPayload {
	title?: string;
	body?: string;
	url?: string;
}

sw.addEventListener('push', (event) => {
	let data: PushPayload = {};
	try {
		if (event.data) data = event.data.json() as PushPayload;
	} catch {
		// A malformed payload still shows a generic notification so
		// the alert is not silently dropped.
	}
	event.waitUntil(
		sw.registration.showNotification(data.title ?? 'Wharfinger', {
			body: data.body ?? '',
			icon: '/favicon.svg',
			data: { url: data.url ?? '/' }
		})
	);
});

sw.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const url =
		((event.notification.data as { url?: string } | undefined)?.url ?? '/').toString() || '/';
	event.waitUntil(
		sw.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
			for (const client of clients) {
				if ('focus' in client) {
					const win = client as WindowClient;
					await win.focus();
					// Same-origin targets navigate the focused window so
					// the alert lands on the right view.
					if (url.startsWith('/')) await win.navigate(url);
					return;
				}
			}
			await sw.clients.openWindow(url);
		})
	);
});
