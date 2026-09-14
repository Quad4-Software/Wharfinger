import { randomBytes } from 'node:crypto';

// Must evaluate before ./build/handler.js: adapter-node reads
// PROTOCOL_HEADER at module load and falls back to https when unset,
// which makes event.url.protocol lie on plain-http installs (Secure
// cookies, wrong absolute URLs). x-wharfinger-proto is stamped per-request
// by server.js from the socket and X-Forwarded-Proto.
process.env.PROTOCOL_HEADER ??= 'x-wharfinger-proto';

// Shared secret between the chat ws bridge (server/chat-ws.mjs) and the
// internal /admin/api/chat endpoints. Random per process start, never
// persisted; routes honor it only from a loopback socket peer, so a
// remote caller can never present it.
process.env.CHAT_INTERNAL_TOKEN ??= randomBytes(24).toString('base64url');
