// Weekly maintenance math, shared by the server snapshot builder and
// the admin panel (for occurrence previews). All times UTC.

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
type Weekday = (typeof WEEKDAYS)[number];

const DAY_MS = 86_400_000;

/** Concrete occurrences of a weekly window in [from, to], all UTC. */
export function weeklyOccurrences(
	weekday: string,
	at: string,
	durationMinutes: number,
	from: number,
	to: number
): { start: number; end: number }[] {
	const dayIdx = WEEKDAYS.indexOf(weekday as Weekday);
	const [hh, mm] = at.split(':').map(Number);
	const offset = (hh * 60 + mm) * 60_000;
	const dur = durationMinutes * 60_000;
	const out: { start: number; end: number }[] = [];

	// Midnight UTC of the first day in range that falls on `weekday`.
	const day0 = Math.floor(from / DAY_MS) * DAY_MS;
	const shift = (((dayIdx - new Date(day0).getUTCDay()) % 7) + 7) % 7;
	for (let day = day0 + shift * DAY_MS - 7 * DAY_MS; day + offset <= to; day += 7 * DAY_MS) {
		const start = day + offset;
		if (start + dur >= from && start <= to) out.push({ start, end: start + dur });
	}
	return out;
}
