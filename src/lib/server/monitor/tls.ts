import { connect } from 'node:tls';
import type { LookupFunction } from 'node:net';

export interface CertInfo {
	/** Whole days until the certificate expires; negative when expired. */
	daysRemaining: number;
	/** True when the chain validated against the default CAs. */
	authorized: boolean;
	/** Certificate expiry, unix ms. */
	validTo: number;
	/** Leaf certificate DER, for DANE/TLSA matching. */
	derCert?: Buffer;
	/** SubjectPublicKeyInfo DER (TLSA selector 1), when available. */
	spki?: Buffer;
}

/** Whole days until an expiry instant (ms, ISO, or ASN.1-style date). */
export function daysUntil(notAfter: Date | string | number, now = Date.now()): number {
	const t =
		typeof notAfter === 'number'
			? notAfter
			: typeof notAfter === 'string'
				? Date.parse(notAfter)
				: notAfter.getTime();
	return Math.floor((t - now) / 86_400_000);
}

/**
 * Probe a TLS endpoint for its peer certificate. Connects without
 * enforcing trust so expiry info is still available for broken certs;
 * callers decide how to treat `authorized`.
 */
export function probeCert(
	host: string,
	port: number,
	timeoutMs: number,
	servername = host,
	lookup?: LookupFunction
): Promise<CertInfo | null> {
	return new Promise((resolve) => {
		const socket = connect({
			host,
			port,
			servername,
			rejectUnauthorized: false,
			...(lookup ? { lookup } : {})
		});
		const finish = (info: CertInfo | null) => {
			socket.destroy();
			resolve(info);
		};
		socket.setTimeout(timeoutMs);
		socket.once('secureConnect', () => {
			const cert = socket.getPeerCertificate();
			const validTo = cert.valid_to ? Date.parse(cert.valid_to) : NaN;
			if (Number.isNaN(validTo)) {
				finish(null);
				return;
			}
			finish({
				daysRemaining: daysUntil(validTo),
				authorized: socket.authorized,
				validTo,
				derCert: cert.raw.length > 0 ? cert.raw : undefined,
				spki: cert.pubkey && cert.pubkey.length > 0 ? cert.pubkey : undefined
			});
		});
		socket.once('timeout', () => {
			finish(null);
		});
		socket.once('error', () => {
			finish(null);
		});
	});
}
