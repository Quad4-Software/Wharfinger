// Minimal user-agent parser for session display. Deliberately local and
// dependency-free: remote icon/UA services would leak admin IPs and add
// an SSRF surface. Order matters; UA tokens overlap (Chrome inside Edge,
// Safari inside Chrome, etc).

export interface ParsedUA {
	browser: string;
	os: string;
	device: 'desktop' | 'mobile' | 'tablet' | 'bot' | 'cli' | 'unknown';
}

export function parseUA(ua: string | null | undefined): ParsedUA {
	if (!ua) return { browser: 'Unknown client', os: '', device: 'unknown' };
	const s = ua.toLowerCase();

	let device: ParsedUA['device'] = 'desktop';
	if (/(bot|crawler|spider|slurp|preview|fetch)/.test(s)) device = 'bot';
	else if (/(curl|wget|httpie|python-requests|go-http-client|okhttp|java\/)/.test(s))
		device = 'cli';
	else if (/(ipad|tablet|kindle)/.test(s)) device = 'tablet';
	else if (/(mobile|iphone|android.*mobile|windows phone)/.test(s)) device = 'mobile';

	let browser = 'Unknown browser';
	if (s.includes('edg/') || s.includes('edge/')) browser = 'Edge';
	else if (s.includes('opr/') || s.includes('opera')) browser = 'Opera';
	else if (s.includes('vivaldi')) browser = 'Vivaldi';
	else if (s.includes('brave')) browser = 'Brave';
	else if (s.includes('firefox/') || s.includes('fxios/')) browser = 'Firefox';
	else if (s.includes('crios/') || s.includes('chrome/')) browser = 'Chrome';
	else if (s.includes('safari/')) browser = 'Safari';
	else if (device === 'cli') browser = 'CLI client';
	else if (device === 'bot') browser = 'Bot';

	let os = '';
	if (s.includes('windows')) os = 'Windows';
	else if (s.includes('android')) os = 'Android';
	else if (/(iphone|ipad|ipod)/.test(s)) os = 'iOS';
	else if (s.includes('mac os') || s.includes('macos')) os = 'macOS';
	else if (s.includes('cros')) os = 'ChromeOS';
	else if (s.includes('linux')) os = 'Linux';
	else if (/(freebsd|openbsd|netbsd)/.test(s)) os = 'BSD';

	return { browser, os, device };
}
