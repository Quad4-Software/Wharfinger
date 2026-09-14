import type { RequestHandler } from './$types';
import { encodeSse, type SseClient } from '$lib/server/sse';
import { getRuntime } from '$lib/server/runtime';

export const GET: RequestHandler = () => {
	const rt = getRuntime();
	let client: SseClient;

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const encoder = new TextEncoder();
			let closed = false;
			client = {
				send(event, data) {
					if (closed) return;
					controller.enqueue(encoder.encode(encodeSse(event, data)));
				},
				close() {
					if (closed) return;
					closed = true;
					try {
						controller.close();
					} catch {
						// already closed
					}
				}
			};
			if (!rt.hub.add(client)) {
				controller.enqueue(encoder.encode(': hub full\n\n'));
				controller.close();
				return;
			}
			// Push the current snapshot immediately so clients can render
			// without a second request.
			client.send('snapshot', rt.snapshot.current().json);
		},
		cancel() {
			rt.hub.remove(client);
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive',
			// Defeat proxy buffering (nginx etc).
			'x-accel-buffering': 'no'
		}
	});
};
