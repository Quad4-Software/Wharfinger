// Wire types for service groups, teams, and secret sets shared by the
// admin API routes and the panel pages. Secret set payloads never carry
// values: keys and metadata only.

export interface GroupMember {
	memberKind: 'service' | 'app';
	memberId: string;
}

export interface ServiceGroup {
	id: string;
	name: string;
	/** Hex color like #3b82f6, null when unset. */
	color: string | null;
	createdAt: number;
	memberCount: number;
	members: GroupMember[];
}

/** Minimal group shape embedded in team payloads and the snapshot. */
export interface GroupRef {
	id: string;
	name: string;
	color: string | null;
}

export interface TeamMember {
	id: number;
	username: string;
	displayName: string;
	hasAvatar: boolean;
}

export interface TeamInfo {
	id: string;
	name: string;
	createdAt: number;
	members: TeamMember[];
	groups: GroupRef[];
}

export interface SecretSetInfo {
	id: string;
	name: string;
	/** Key names only; values never leave the store unsealed via API. */
	keys: string[];
	createdAt: number;
	updatedAt: number;
}
