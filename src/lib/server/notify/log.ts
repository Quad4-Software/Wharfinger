import type { DatabaseSync } from 'node:sqlite';
import { NOTIFICATION_LOG_MAX } from '$lib/server/constants';
import { asDb, type Db } from '$lib/server/store/driver';

export interface NotificationLogEntry {
	id: number;
	target: string;
	kind: string;
	event: string;
	serviceId: string | null;
	ok: boolean;
	status: number | null;
	error: string | null;
	at: number;
}

/** Delivery history for outbound notifications, shown in the panel. */
export class NotificationLog {
	private readonly db: Db;

	constructor(db: Db | DatabaseSync) {
		this.db = asDb(db);
	}

	async record(entry: {
		target: string;
		kind: string;
		event: string;
		serviceId?: string | null;
		ok: boolean;
		status?: number | null;
		error?: string | null;
	}): Promise<void> {
		await this.db
			.prepare(
				'INSERT INTO notification_log (target, kind, event, service_id, ok, status, error, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
			)
			.run(
				entry.target,
				entry.kind,
				entry.event,
				entry.serviceId ?? null,
				entry.ok ? 1 : 0,
				entry.status ?? null,
				entry.error?.slice(0, 500) ?? null,
				Date.now()
			);
	}

	async recent(limit = 50): Promise<NotificationLogEntry[]> {
		return (await this.db
			.prepare(
				'SELECT id, target, kind, event, service_id AS serviceId, ok, status, error, at FROM notification_log ORDER BY at DESC LIMIT ?'
			)
			.all(limit)) as unknown as NotificationLogEntry[];
	}

	async lastForTarget(name: string): Promise<NotificationLogEntry | null> {
		return (
			((await this.db
				.prepare(
					'SELECT id, target, kind, event, service_id AS serviceId, ok, status, error, at FROM notification_log WHERE target = ? ORDER BY at DESC LIMIT 1'
				)
				.get(name)) as NotificationLogEntry | undefined) ?? null
		);
	}

	async prune(): Promise<void> {
		// id NOT IN (SELECT id ...) compares record ids on both
		// drivers, so the keep-newest-N form is portable as written.
		await this.db
			.prepare(
				'DELETE FROM notification_log WHERE id NOT IN (SELECT id FROM notification_log ORDER BY at DESC LIMIT ?)'
			)
			.run(NOTIFICATION_LOG_MAX);
	}
}
