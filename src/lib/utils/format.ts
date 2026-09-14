export function fmtPct(v: number | null): string {
	return v === null ? 'N/A' : `${v.toFixed(v >= 99.95 && v < 100 ? 3 : 2)}%`;
}

export function fmtMs(v: number | null): string {
	if (v === null) return 'N/A';
	if (v < 1) return '<1ms';
	if (v < 1000) return `${Math.round(v)}ms`;
	return `${(v / 1000).toFixed(2)}s`;
}

export function fmtDate(iso: string): string {
	return new Date(iso).toLocaleDateString(undefined, {
		year: 'numeric',
		month: 'short',
		day: 'numeric'
	});
}

export function fmtDateTime(iso: string): string {
	return new Date(iso).toLocaleString(undefined, {
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit'
	});
}

export function relativeTime(isoOrMs: string | number, now = Date.now()): string {
	const then = typeof isoOrMs === 'string' ? Date.parse(isoOrMs) : isoOrMs;
	const diff = now - then;
	const abs = Math.abs(diff);
	const units: [number, Intl.RelativeTimeFormatUnit][] = [
		[86_400_000, 'day'],
		[3_600_000, 'hour'],
		[60_000, 'minute'],
		[1_000, 'second']
	];
	const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
	for (const [ms, unit] of units) {
		if (abs >= ms) return rtf.format(Math.round(-diff / ms), unit);
	}
	return 'just now';
}

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

export function fmtBytes(v: number | null | undefined): string {
	if (v === null || v === undefined) return 'N/A';
	let n = v;
	let i = 0;
	while (n >= 1024 && i < BYTE_UNITS.length - 1) {
		n /= 1024;
		i++;
	}
	return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${BYTE_UNITS[i]}`;
}

export function fmtRate(v: number | null | undefined): string {
	if (v === null || v === undefined) return 'N/A';
	return `${fmtBytes(v)}/s`;
}

/** Uptime-style duration: "3d 4h", "7h 12m", "42m". */
export function fmtUptime(sec: number | null | undefined): string {
	if (sec === null || sec === undefined) return 'N/A';
	const mins = Math.floor(sec / 60);
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 48) return `${hours}h ${mins % 60}m`;
	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function durationBetween(startIso: string, endIso: string | null): string {
	const start = Date.parse(startIso);
	const end = endIso ? Date.parse(endIso) : Date.now();
	const mins = Math.max(0, Math.round((end - start) / 60_000));
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 48) return `${hours}h ${mins % 60}m`;
	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
