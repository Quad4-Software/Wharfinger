// Server-side limits and TTLs in one place. Tune here, not in modules.

export const DAY_MS = 86_400_000;

// Rate limiting for the public JSON API (per client key, fixed window).
export const RATE_LIMIT_MAX = 240;
export const RATE_LIMIT_WINDOW_MS = 60_000;

// SSE hub bounds and keepalive.
export const SSE_MAX_CLIENTS = 1000;
export const SSE_HEARTBEAT_MS = 25_000;

// Favicon fetcher bounds.
export const ICON_TTL_MS = 24 * 3600_000;
export const ICON_MAX_BYTES = 512 * 1024;
export const ICON_HTML_MAX_BYTES = 1024 * 1024;
export const ICON_FETCH_TIMEOUT_MS = 8000;

// Snapshot horizons.
export const RECENT_INCIDENTS_MAX = 15;
export const UPCOMING_WINDOW_DAYS = 42;
export const UPCOMING_WINDOW_MAX = 12;

// Admin panel.
export const SESSION_COOKIE = 'wharfinger_admin';
export const OIDC_COOKIE = 'wharfinger_oidc';
export const TOKEN_BYTES = 32;
export const AUTH_LIMIT_MAX = 10;
export const AUTH_LIMIT_WINDOW_MS = 60_000;
export const ADMIN_API_LIMIT_MAX = 240;
export const ADMIN_API_LIMIT_WINDOW_MS = 60_000;
export const LOGIN_ATTEMPT_RETENTION_MS = 24 * 3600_000;
export const AUDIT_LOG_MAX = 5000;
export const NOTIFICATION_LOG_MAX = 1000;
export const AUDIT_PAGE_SIZE = 50;
// scrypt parameters: ~100ms per verify on modest hardware.
export const SCRYPT_N = 16384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const TOTP_STEP_SECONDS = 30;
export const TOTP_WINDOW = 1;
export const TOTP_BACKUP_CODES = 8;
// WebAuthn ceremony challenge lifetime; the browser prompt itself
// usually times out around 60s.
export const WEBAUTHN_CHALLENGE_TTL_MS = 120_000;
