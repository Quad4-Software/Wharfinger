// Client-safe auth surface: roles and the public user shape.
// Role names resolve against the roles table (RoleStore); 'admin',
// 'operator', and 'viewer' are seeded builtins, custom names follow
// the role-name policy enforced by the roles API.
export type Role = string;

export interface PublicUser {
	id: number;
	username: string;
	displayName: string;
	role: Role;
	totpEnabled: boolean;
	createdAt: number;
	disabledAt: number | null;
	lastLoginAt: number | null;
	/** True when an avatar image is stored; fetch bytes via the avatar route. */
	hasAvatar?: boolean;
}

// Passkey metadata shown on the account page. The credential id,
// public key, and sign counter never leave the server.
export interface PasskeyInfo {
	id: number;
	name: string;
	createdAt: number;
	lastUsedAt: number | null;
	backedUp: boolean;
}
