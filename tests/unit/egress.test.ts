import { describe, expect, it } from 'vitest';
import { blockedHost, blockedIp, EGRESS_BLOCKED_DETAIL, makeEgress } from '$lib/server/http/egress';

// SSRF guard: cloud metadata endpoints live in link-local space and
// must be refused by outbound checks and notification sends, while
// LAN monitoring keeps working.

describe('blockedIp', () => {
	it('blocks link-local and cloud metadata addresses', () => {
		for (const ip of [
			'169.254.169.254',
			'169.254.170.2',
			'169.254.0.1',
			'0.0.0.0',
			'0.1.2.3',
			'100.100.100.200',
			'fe80::1',
			'feb0::1',
			'fd00:ec2::254',
			'::ffff:169.254.169.254',
			'::ffff:a9fe:a9fe',
			'::'
		]) {
			expect(blockedIp(ip), ip).toBe(true);
		}
	});

	it('allows loopback, private, and public addresses', () => {
		for (const ip of [
			'127.0.0.1',
			'10.0.0.5',
			'172.16.20.3',
			'192.168.1.10',
			'8.8.8.8',
			'1.1.1.1',
			'::1',
			'fd00::5',
			'2606:4700:4700::1111'
		]) {
			expect(blockedIp(ip), ip).toBe(false);
		}
	});
});

describe('blockedHost', () => {
	it('blocks literal IPs and metadata hostnames', () => {
		expect(blockedHost('169.254.169.254')).toBe(true);
		expect(blockedHost('[::ffff:169.254.169.254]')).toBe(true);
		expect(blockedHost('metadata.google.internal')).toBe(true);
		expect(blockedHost('Metadata.Google.Internal.')).toBe(true);
		expect(blockedHost('example.com')).toBe(false);
		expect(blockedHost('status.internal')).toBe(false);
	});
});

describe('guarded lookup', () => {
	function lookupOnce(egress: ReturnType<typeof makeEgress>, host: string) {
		return new Promise<{ err: NodeJS.ErrnoException | null; address: unknown }>((resolve) => {
			egress.lookup(host, {}, (err, address) => {
				resolve({ err, address });
			});
		});
	}

	it('rejects lookups that resolve to blocked addresses', async () => {
		const egress = makeEgress(() => false);
		const r = await lookupOnce(egress, '169.254.169.254');
		expect(r.err?.code).toBe('EAI_BLOCKED');
		expect(r.err?.message).toBe(EGRESS_BLOCKED_DETAIL);
	});

	it('resolves localhost normally', async () => {
		const egress = makeEgress(() => false);
		const r = await lookupOnce(egress, 'localhost');
		expect(r.err).toBeNull();
	});

	it('honors the allow flag at call time', async () => {
		let allow = false;
		const egress = makeEgress(() => allow);
		expect((await lookupOnce(egress, '169.254.169.254')).err?.code).toBe('EAI_BLOCKED');
		allow = true;
		expect((await lookupOnce(egress, '169.254.169.254')).err).toBeNull();
	});
});
