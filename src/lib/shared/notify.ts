// Notification event names shared between the config schema, the
// dispatcher, and the admin UI.
export const NOTIFY_EVENTS = ['down', 'degraded', 'recovered', 'maintenance', 'incident'] as const;

export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];
