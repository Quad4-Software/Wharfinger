import type { CheckOutcome } from './checkers';
import type { ServiceStatus } from '$lib/shared/status';

// Per-service flap protection. A service only changes public status after
// `threshold` consecutive results in that direction, so a single dropped
// packet does not page the status page.
export class ServiceState {
	status: ServiceStatus = 'unknown';
	private bad = 0;
	private good = 0;

	constructor(
		private readonly failureThreshold: number,
		private readonly recoveryThreshold: number
	) {}

	/** Returns the new status if it changed, else null. */
	apply(outcome: CheckOutcome): ServiceStatus | null {
		const result: 'good' | 'degraded' | 'bad' = outcome.ok
			? outcome.degraded
				? 'degraded'
				: 'good'
			: 'bad';

		if (result === 'good') {
			this.good += 1;
			this.bad = 0;
		} else {
			this.bad += 1;
			this.good = 0;
		}

		let next = this.status;
		if (this.bad >= this.failureThreshold) {
			next = result === 'bad' ? 'major_outage' : 'degraded';
			// Keep degraded if the failure streak was built on degraded results
			// only: treat any hard failure within the streak as a real outage.
			if (result === 'degraded' && this.status === 'major_outage') next = 'major_outage';
		} else if (this.good >= this.recoveryThreshold) {
			next = 'operational';
		} else if (this.status === 'unknown' && this.bad > 0) {
			// Before thresholds are met on a fresh start, report the observed
			// direction instead of staying 'unknown' forever.
			next = result === 'bad' ? 'major_outage' : 'degraded';
		} else if (this.status === 'unknown' && this.good > 0) {
			next = 'operational';
		}

		if (next !== this.status) {
			this.status = next;
			return next;
		}
		return null;
	}
}
