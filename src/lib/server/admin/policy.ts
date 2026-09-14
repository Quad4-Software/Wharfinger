// Input policy for account fields. Kept dependency-free and strict.

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;

export function checkPassword(
	password: string,
	username: string,
	minLength: number
): string | null {
	// Code points, not UTF-16 units: astral characters should not
	// double-count toward the minimum.
	if (Array.from(password).length < minLength) {
		return `password must be at least ${minLength} characters`;
	}
	if (password.length > 256) return 'password is too long';
	if (username && password.toLowerCase().includes(username.toLowerCase())) {
		return 'password must not contain the username';
	}
	return null;
}
