import type { User } from '$lib/server/admin/users';
import type { Permission } from '$lib/server/admin/authz';

declare global {
	namespace App {
		interface Error {
			message: string;
			/** Correlation id logged and reported for unexpected failures. */
			errorId?: string;
		}
		interface Locals {
			/** Authenticated admin user, null outside the panel or signed out. */
			user: User | null;
			/** Permission set resolved from the roles table at session lookup. */
			perms: ReadonlySet<Permission> | null;
			/** sha256 of the live session token, for self-referencing. */
			sessionHash: string | null;
			/** External mount path of the admin panel (e.g. /admin). */
			adminBase: string;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
