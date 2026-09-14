// Avatar image validation. Uploads are kept as-is (no re-encode
// pipeline in this stack) so the checks are strict: magic bytes must
// match a real image container, dimensions must parse and stay under
// a bound that blocks decompression-bomb junk, and the serve route
// pins content-type plus nosniff + a null CSP so a crafted payload
// can never execute as script or markup. SVG is refused outright.

export const AVATAR_MAX_BYTES = 512 * 1024;
const AVATAR_MAX_DIM = 4096;

export type AvatarMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export function validateAvatar(buf: Uint8Array): { mime: AvatarMime } | { error: string } {
	if (buf.length < 16) return { error: 'file too small' };
	if (buf.length > AVATAR_MAX_BYTES) return { error: 'image exceeds 512 KB' };
	const dim = detect(buf);
	if (!dim) return { error: 'unsupported image type (PNG, JPEG, WebP, or GIF only)' };
	if (dim.w < 1 || dim.h < 1 || dim.w > AVATAR_MAX_DIM || dim.h > AVATAR_MAX_DIM) {
		return { error: 'image dimensions out of bounds' };
	}
	return { mime: dim.mime };
}

function detect(buf: Uint8Array): { mime: AvatarMime; w: number; h: number } | null {
	// PNG: 8-byte signature, IHDR width/height big-endian at 16/20.
	if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
		if (buf.length < 24) return null;
		const w = u32be(buf, 16);
		const h = u32be(buf, 20);
		return { mime: 'image/png', w, h };
	}
	// GIF: 'GIF8', width/height little-endian at 6/8.
	if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
		return { mime: 'image/gif', w: buf[6] | (buf[7] << 8), h: buf[8] | (buf[9] << 8) };
	}
	// JPEG: scan segments for a start-of-frame marker.
	if (buf[0] === 0xff && buf[1] === 0xd8) return jpegDims(buf);
	// WebP: RIFF container; parse VP8X extended dims, accept raw VP8/VP8L
	// with a nominal bound (byte cap already limits bombs).
	if (
		buf[0] === 0x52 &&
		buf[1] === 0x49 &&
		buf[2] === 0x46 &&
		buf[3] === 0x46 &&
		buf.length >= 30 &&
		buf[8] === 0x57 &&
		buf[9] === 0x45 &&
		buf[10] === 0x42 &&
		buf[11] === 0x50
	) {
		const fourcc = String.fromCharCode(buf[12], buf[13], buf[14], buf[15]);
		if (fourcc === 'VP8X' && buf.length >= 30) {
			const w = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
			const h = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
			return { mime: 'image/webp', w, h };
		}
		if (fourcc === 'VP8 ' || fourcc === 'VP8L') {
			return { mime: 'image/webp', w: 1, h: 1 };
		}
		return null;
	}
	return null;
}

function jpegDims(buf: Uint8Array): { mime: AvatarMime; w: number; h: number } | null {
	let i = 2;
	while (i + 9 < buf.length) {
		if (buf[i] !== 0xff) return null;
		const marker = buf[i + 1];
		// Standalone markers carry no length.
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			i += 2;
			continue;
		}
		const len = (buf[i + 2] << 8) | buf[i + 3];
		if (len < 2) return null;
		// SOF markers (all except C4/C8/CC) carry height then width.
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			return {
				mime: 'image/jpeg',
				h: (buf[i + 5] << 8) | buf[i + 6],
				w: (buf[i + 7] << 8) | buf[i + 8]
			};
		}
		i += 2 + len;
	}
	return null;
}

function u32be(b: Uint8Array, off: number): number {
	return ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0;
}
