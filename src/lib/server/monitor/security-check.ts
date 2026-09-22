import { blockedHost, EGRESS_BLOCKED_DETAIL, type FetchInit } from '$lib/server/http/egress';
import type { ServiceConfig } from '$lib/server/config/schema';
import { SECURITY_CHECKS, type SecurityCheckName } from '$lib/shared/drafts';
import type { CheckContext, CheckOutcome } from './checkers';
import { probeCert } from './tls';

// External security posture check, inspired by web-check. The URL is
// fetched through the egress guard with a bounded manual redirect
// chain (every hop is re-validated, so a redirect cannot escape the
// guard), then the TLS state, security headers, cookie flags, mixed
// content and security.txt are graded into a 0-100 score. Reachable
// is always ok; warnings degrade; min_score sets the pass bar; only
// an unreachable target reads as down.

const MAX_REDIRECTS = 5;
const MAX_HTML_BYTES = 256 * 1024;
const MAX_SECTXT_BYTES = 64 * 1024;
const MAX_COOKIES = 20;
const MAX_COOKIE_NAMES = 3;
const MAX_DETAIL_LEN = 240;

export interface SecurityFinding {
	check: SecurityCheckName;
	severity: 'info' | 'warn';
	detail: string;
	/** Points deducted from the 100 base score. */
	penalty: number;
}

function finding(
	check: SecurityCheckName,
	severity: 'info' | 'warn',
	detail: string,
	penalty: number
): SecurityFinding {
	return { check, severity, detail, penalty };
}

export function scoreFindings(findings: SecurityFinding[]): number {
	const penalty = findings.reduce((n, f) => n + f.penalty, 0);
	return Math.max(0, Math.min(100, 100 - Math.round(penalty)));
}

// Six presence checks, matching the domain composite's headerScore:
// the CSP frame-ancestors directive counts as frame protection in
// place of x-frame-options. HSTS is skipped on plain http, where the
// header is ignored anyway.
export function headerChecks(
	headers: Headers,
	isHttps: boolean
): { satisfied: number; total: number; findings: SecurityFinding[] } {
	const findings: SecurityFinding[] = [];
	const csp = headers.get('content-security-policy') ?? '';
	const frameOk = headers.get('x-frame-options') !== null || /frame-ancestors/i.test(csp);
	const total = isHttps ? 6 : 5;
	if (isHttps && headers.get('strict-transport-security') === null) {
		findings.push(finding('headers', 'warn', 'no HSTS', 10));
	}
	if (csp === '') {
		findings.push(finding('headers', 'warn', 'no Content-Security-Policy', 12));
	}
	if (!frameOk) {
		findings.push(finding('headers', 'warn', 'no frame protection', 6));
	}
	if (headers.get('x-content-type-options') === null) {
		findings.push(finding('headers', 'warn', 'no X-Content-Type-Options', 5));
	}
	if (headers.get('referrer-policy') === null) {
		findings.push(finding('headers', 'info', 'no Referrer-Policy', 3));
	}
	if (headers.get('permissions-policy') === null) {
		findings.push(finding('headers', 'info', 'no Permissions-Policy', 3));
	}
	return { satisfied: total - findings.length, total, findings };
}

export interface CookieFlags {
	name: string;
	secure: boolean;
	httpOnly: boolean;
	sameSite: boolean;
}

// Parses one Set-Cookie line into its flag set. The cookie value is
// never read beyond splitting it off, so nothing sensitive is kept.
export function parseCookieFlags(line: string): CookieFlags {
	const [pair, ...attrs] = line.split(';');
	const flags = new Set(attrs.map((a) => a.trim().toLowerCase().split('=', 1)[0]));
	return {
		name: pair.split('=', 1)[0].trim(),
		secure: flags.has('secure'),
		httpOnly: flags.has('httponly'),
		sameSite: flags.has('samesite')
	};
}

// One finding per missing flag, naming a few offending cookies. On
// plain http everything is already downgraded by the tls finding, so
// a missing Secure flag is informational only.
export function cookieFindings(lines: string[], isHttps: boolean): SecurityFinding[] {
	const cookies = lines.slice(0, MAX_COOKIES).map(parseCookieFlags);
	if (cookies.length === 0) return [];
	const names = (cs: CookieFlags[]) =>
		cs
			.map((c) => c.name || '?')
			.slice(0, MAX_COOKIE_NAMES)
			.join(', ');
	const out: SecurityFinding[] = [];
	const noSecure = cookies.filter((c) => !c.secure);
	if (noSecure.length > 0) {
		out.push(
			finding(
				'cookies',
				isHttps ? 'warn' : 'info',
				`${noSecure.length} cookie(s) without Secure: ${names(noSecure)}`,
				isHttps ? 5 : 2
			)
		);
	}
	const noHttpOnly = cookies.filter((c) => !c.httpOnly);
	if (noHttpOnly.length > 0) {
		out.push(
			finding(
				'cookies',
				'info',
				`${noHttpOnly.length} cookie(s) without HttpOnly: ${names(noHttpOnly)}`,
				3
			)
		);
	}
	const noSameSite = cookies.filter((c) => !c.sameSite);
	if (noSameSite.length > 0) {
		out.push(
			finding(
				'cookies',
				'info',
				`${noSameSite.length} cookie(s) without SameSite: ${names(noSameSite)}`,
				2
			)
		);
	}
	return out;
}

// Subresource references that would load over plain http inside an
// https page. Anchor href is navigation, not mixed content, so only
// resource-loading attributes, link tags and CSS url() are matched.
const MIXED_ATTR =
	/\b(?:src|srcset|action|formaction|poster|data|background)\s*=\s*["']\s*([^"'>]+)/gi;
const MIXED_CSS = /url\(\s*["']?\s*(http:\/\/[^\s"')]+)/gi;
const MIXED_LINK = /<link\b[^>]*?\bhref\s*=\s*["']\s*(http:\/\/[^\s"'>]+)/gi;

export function findMixedContent(html: string): { count: number; samples: string[] } {
	const seen = new Set<string>();
	const add = (raw: string) => {
		// srcset values are comma separated lists of URL + descriptor.
		for (const part of raw.split(',')) {
			const u = part.trim().split(/\s/, 1)[0] ?? '';
			if (u.toLowerCase().startsWith('http://')) seen.add(u);
		}
	};
	for (const re of [MIXED_ATTR, MIXED_CSS, MIXED_LINK]) {
		re.lastIndex = 0;
		for (const m of html.matchAll(re)) {
			if (m[1]) add(m[1]);
		}
	}
	return { count: seen.size, samples: [...seen].slice(0, 5) };
}

// Server tokens that disclose the platform; digits in the value mean
// a version leak, which is the part worth warning about.
const DISCLOSURE_HEADERS = ['server', 'x-powered-by', 'x-aspnet-version', 'x-generator'];

export function disclosureFindings(headers: Headers): SecurityFinding[] {
	const out: SecurityFinding[] = [];
	for (const name of DISCLOSURE_HEADERS) {
		const value = headers.get(name);
		if (value === null || value.trim() === '') continue;
		const versioned = /\d/.test(value);
		out.push(
			finding(
				'server-disclosure',
				versioned ? 'warn' : 'info',
				`${name} header discloses ${versioned ? 'a version' : 'the platform'}`,
				versioned ? 5 : 2
			)
		);
	}
	return out;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

interface ChainHop {
	url: string;
	status: number;
}

interface ChainResult {
	hops: ChainHop[];
	response: Response;
	/** Last response was still a redirect when the hop limit hit. */
	exceeded: boolean;
	/** A redirect target refused by the link-local pre-check. */
	blockedAt?: URL;
}

// Manual redirect following: each hop re-enters the egress dispatcher
// (which validates DNS at connect time) and passes the literal-IP
// pre-check, so a redirect can never reach a blocked target. Hop
// count and the shared deadline bound the whole chain.
async function fetchChain(
	start: URL,
	ctx: CheckContext,
	maxHops: number,
	deadline: number,
	accept: string
): Promise<ChainResult> {
	const hops: ChainHop[] = [];
	let current = start;
	for (;;) {
		const remain = Math.max(250, Math.ceil(deadline - performance.now()));
		const res = await fetch(current, {
			method: 'GET',
			redirect: 'manual',
			dispatcher: ctx.egress.dispatcher,
			signal: AbortSignal.timeout(remain),
			headers: { 'user-agent': ctx.userAgent, accept }
		} as FetchInit);
		hops.push({ url: current.toString(), status: res.status });
		const loc = res.headers.get('location');
		const isRedirect = REDIRECT_STATUSES.has(res.status) && loc !== null;
		if (!isRedirect || hops.length - 1 >= maxHops) {
			return { hops, response: res, exceeded: isRedirect };
		}
		let next: URL;
		try {
			next = new URL(loc, current);
		} catch {
			return { hops, response: res, exceeded: false };
		}
		// Non-http(s) targets (javascript:, data:, ...) end the chain.
		if (next.protocol !== 'http:' && next.protocol !== 'https:') {
			return { hops, response: res, exceeded: false };
		}
		if (!ctx.egress.allowLinkLocal() && blockedHost(next.hostname)) {
			return { hops, response: res, exceeded: false, blockedAt: next };
		}
		// Drain so the socket can be reused before the next hop.
		await res.arrayBuffer().catch(() => undefined);
		current = next;
	}
}

function redirectFindings(chain: ChainResult): SecurityFinding[] {
	const out: SecurityFinding[] = [];
	if (chain.exceeded) {
		out.push(finding('redirects', 'warn', `redirect chain exceeds ${MAX_REDIRECTS} hops`, 10));
	}
	if (chain.blockedAt) {
		out.push(finding('redirects', 'warn', 'redirect target blocked by egress policy', 8));
	}
	for (let i = 0; i + 1 < chain.hops.length; i++) {
		const from = new URL(chain.hops[i].url);
		const to = new URL(chain.hops[i + 1].url);
		if (from.protocol === 'https:' && to.protocol === 'http:') {
			out.push(finding('redirects', 'warn', 'redirect downgrades https to http', 20));
			break;
		}
	}
	const redirects = chain.hops.length - 1;
	if (!chain.exceeded && redirects > 3) {
		out.push(finding('redirects', 'info', `${redirects} redirect hops`, 2));
	}
	return out;
}

// RFC 9116 requires a Contact field; a bare 200 is not enough since
// many sites serve a soft-404 page at unknown paths.
export function securityTxtOk(status: number, body: string): boolean {
	return status === 200 && /^\s*contact\s*:/im.test(body);
}

// true: published and valid. false: absent or invalid. null: the
// probe itself failed, which says nothing about the site.
async function fetchSecurityTxt(
	finalUrl: URL,
	ctx: CheckContext,
	deadline: number
): Promise<boolean | null> {
	try {
		const target = new URL('/.well-known/security.txt', finalUrl);
		if (!ctx.egress.allowLinkLocal() && blockedHost(target.hostname)) return false;
		const chain = await fetchChain(target, ctx, 2, deadline, 'text/plain, */*;q=0.5');
		const body = await readBounded(chain.response, MAX_SECTXT_BYTES);
		return securityTxtOk(chain.response.status, body);
	} catch {
		return null;
	}
}

async function readBounded(res: Response, max: number): Promise<string> {
	const reader = res.body?.getReader();
	if (!reader) return res.text();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			total += value.byteLength;
			if (total > max) break;
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	const out = new Uint8Array(Math.min(total, max));
	let off = 0;
	for (const c of chunks) {
		const slice = c.subarray(0, Math.min(c.byteLength, out.byteLength - off));
		out.set(slice, off);
		off += slice.byteLength;
		if (off >= out.byteLength) break;
	}
	return new TextDecoder().decode(out);
}

export async function checkSecurity(
	service: Extract<ServiceConfig, { type: 'security' }>,
	ctx: CheckContext
): Promise<CheckOutcome> {
	const start = new URL(service.url);
	if (!ctx.egress.allowLinkLocal() && blockedHost(start.hostname)) {
		return { ok: false, degraded: false, latencyMs: 0, detail: EGRESS_BLOCKED_DETAIL };
	}
	const enabled = new Set<SecurityCheckName>(
		service.checks && service.checks.length > 0 ? service.checks : SECURITY_CHECKS
	);
	const started = performance.now();
	const deadline = started + ctx.timeoutMs;
	const chain = await fetchChain(
		start,
		ctx,
		MAX_REDIRECTS,
		deadline,
		'text/html, application/xhtml+xml, */*;q=0.8'
	);
	const res = chain.response;
	const finalUrl = new URL(chain.hops[chain.hops.length - 1].url);
	const isHttps = finalUrl.protocol === 'https:';
	const findings: SecurityFinding[] = [];
	const notes: string[] = [`HTTP ${res.status}`];
	if (chain.hops.length > 1) notes.push(`${chain.hops.length - 1} redirects`);

	if (enabled.has('redirects')) findings.push(...redirectFindings(chain));

	let headerNote = '';
	if (enabled.has('headers')) {
		const h = headerChecks(res.headers, isHttps);
		findings.push(...h.findings);
		headerNote = `headers ${h.satisfied}/${h.total}`;
	}
	if (enabled.has('server-disclosure')) {
		findings.push(...disclosureFindings(res.headers));
	}
	if (enabled.has('cookies')) {
		findings.push(...cookieFindings(res.headers.getSetCookie(), isHttps));
	}

	// The HTML body is only read for the mixed-content scan, is byte
	// capped, and is never stored or logged.
	const htmlish = /text\/html|application\/xhtml/i.test(res.headers.get('content-type') ?? '');
	if (enabled.has('mixed-content') && isHttps && htmlish) {
		const mixed = findMixedContent(await readBounded(res, MAX_HTML_BYTES));
		if (mixed.count > 0) {
			findings.push(
				finding(
					'mixed-content',
					'warn',
					`${mixed.count} mixed-content URL(s)`,
					Math.min(15, 5 + mixed.count)
				)
			);
		}
	} else {
		// Drain a bounded slice so the socket can be reused.
		await readBounded(res, 64 * 1024).catch(() => '');
	}

	let certDays: number | undefined;
	if (enabled.has('tls')) {
		if (isHttps) {
			const port = finalUrl.port ? Number(finalUrl.port) : 443;
			const cert = await probeCert(
				finalUrl.hostname,
				port,
				Math.max(500, Math.ceil(deadline - performance.now())),
				finalUrl.hostname,
				ctx.egress.lookup
			);
			if (cert === null) {
				findings.push(finding('tls', 'warn', 'cert probe failed', 8));
			} else {
				certDays = cert.daysRemaining;
				notes.push(`cert ${certDays}d`);
				if (!cert.authorized) {
					findings.push(finding('tls', 'warn', 'certificate not trusted', 25));
				} else if (certDays <= ctx.certWarnDays) {
					findings.push(finding('tls', 'warn', `cert expires in ${certDays}d`, 10));
				}
			}
		} else {
			findings.push(finding('tls', 'warn', 'served over plain http', 15));
		}
	}

	if (enabled.has('security-txt')) {
		const r = await fetchSecurityTxt(finalUrl, ctx, deadline);
		if (r === true) notes.push('security.txt ok');
		else if (r === false) findings.push(finding('security-txt', 'info', 'no security.txt', 2));
		else findings.push(finding('security-txt', 'info', 'security.txt fetch failed', 0));
	}

	const score = scoreFindings(findings);
	const warns = findings.filter((f) => f.severity === 'warn');
	const belowMin = service.min_score !== undefined && score < service.min_score;
	const latencyMs = performance.now() - started;

	const detail = [`score ${score}/100`, ...notes];
	if (headerNote) detail.push(headerNote);
	if (warns.length > 0) {
		detail.push(`warn: ${warns.map((f) => f.detail).join(', ')}`);
	}
	if (belowMin) detail.push(`below min_score ${service.min_score}`);

	return {
		ok: true,
		degraded: warns.length > 0 || belowMin || latencyMs > ctx.degradedMs,
		latencyMs,
		detail: detail.join(' · ').slice(0, MAX_DETAIL_LEN),
		certDays
	};
}
