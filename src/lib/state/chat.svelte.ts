// Shared chat unread counter. The chat page writes it; AdminShell
// reads it for the nav badge dot so unread state survives navigation
// away from the page.
let unread = $state(0);

export function chatUnread(): number {
	return unread;
}

export function setChatUnread(n: number): void {
	unread = Math.max(0, n);
}
