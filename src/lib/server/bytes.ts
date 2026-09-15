// Blob columns read back as Uint8Array from sqlite and as base64 text
// from SurrealDB (the driver binds Uint8Array as base64 on the wire).
// asBytes normalizes both shapes at the store boundary so callers only
// ever see bytes.
export function asBytes(v: unknown): Uint8Array | null {
	if (v instanceof Uint8Array) return v;
	if (typeof v === 'string') return new Uint8Array(Buffer.from(v, 'base64'));
	return null;
}
