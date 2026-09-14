import type { HandleClientError } from '@sveltejs/kit';
import { isHttpError } from '@sveltejs/kit';
import { version } from '$app/environment';
import { sendClientReport } from '$lib/shared/telemetry';

/**
 * Browser-side error hook. Unexpected errors are relayed to the server
 * telemetry endpoint (which forwards to the configured Sentry-compatible
 * backend); expected HttpErrors like 404 navigations are not reported.
 */
export const handleError: HandleClientError = ({ error, event, status, message }) => {
	if (!isHttpError(error) || status >= 500) {
		const err = error instanceof Error ? error : new Error(String(error));
		sendClientReport({
			name: err.name,
			message: err.message,
			stack: err.stack,
			url: event.url.href,
			routeId: event.route.id ?? undefined,
			status,
			handled: false,
			mechanism: 'sveltekit.handleError',
			extra: { renderedMessage: message, version }
		});
	}
	return { message };
};
