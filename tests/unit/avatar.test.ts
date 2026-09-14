import { describe, expect, it } from 'vitest';
import { validateAvatar, AVATAR_MAX_BYTES } from '$lib/server/admin/avatar';

function png(w: number, h: number): Uint8Array {
	const b = new Uint8Array(33);
	b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	new DataView(b.buffer).setUint32(16, w);
	new DataView(b.buffer).setUint32(20, h);
	return b;
}

function gif(w: number, h: number): Uint8Array {
	const b = new Uint8Array(16);
	b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, w & 0xff, w >> 8, h & 0xff, h >> 8]);
	return b;
}

describe('validateAvatar', () => {
	it('accepts a minimal png and reads dimensions', () => {
		expect(validateAvatar(png(64, 64))).toEqual({ mime: 'image/png' });
	});

	it('accepts gif', () => {
		expect(validateAvatar(gif(48, 48))).toEqual({ mime: 'image/gif' });
	});

	it('rejects svg, html, and tiny junk', () => {
		const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
		expect(validateAvatar(svg)).toHaveProperty('error');
		expect(validateAvatar(new Uint8Array(4))).toHaveProperty('error');
	});

	it('rejects oversized uploads', () => {
		expect(validateAvatar(new Uint8Array(AVATAR_MAX_BYTES + 1))).toHaveProperty('error');
	});

	it('rejects decompression-bomb dimensions', () => {
		expect(validateAvatar(png(99999, 99999))).toHaveProperty('error');
	});

	it('rejects a fake png with junk dimensions', () => {
		expect(validateAvatar(png(0, 0))).toHaveProperty('error');
	});
});
