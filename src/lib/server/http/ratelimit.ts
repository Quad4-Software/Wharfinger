// Fixed-window per-client rate limiter for the JSON API. Deliberately
// small and in-memory: this sits behind the public site and only guards
// against accidental polling storms, not adversarial abuse (that belongs
// at the edge/CDN).

interface Bucket {
	count: number;
	resetAt: number;
}

export class RateLimiter {
	private buckets = new Map<string, Bucket>();
	private lastSweep = Date.now();

	constructor(
		private readonly limit: number,
		private readonly windowMs: number
	) {}

	allow(key: string, now = Date.now()): boolean {
		if (now - this.lastSweep > this.windowMs * 4) this.sweep(now);
		let b = this.buckets.get(key);
		if (!b || b.resetAt <= now) {
			b = { count: 0, resetAt: now + this.windowMs };
			this.buckets.set(key, b);
		}
		b.count += 1;
		return b.count <= this.limit;
	}

	private sweep(now: number): void {
		this.lastSweep = now;
		for (const [k, b] of this.buckets) {
			if (b.resetAt <= now) this.buckets.delete(k);
		}
	}
}
