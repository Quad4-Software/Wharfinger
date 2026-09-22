import {
	LayoutDashboard,
	Activity,
	Server,
	Wrench,
	Siren,
	Files,
	CalendarDays,
	Palette,
	Bell,
	Bug,
	Users,
	ScrollText,
	Settings,
	MessageSquare,
	Rocket,
	ShieldCheck,
	Radar,
	Boxes,
	UsersRound,
	KeyRound,
	CircleUser
} from '@lucide/svelte';

export interface NavItem {
	sub: string;
	label: string;
	icon: typeof Activity;
	perm?: string;
}

export interface NavSection {
	label: string | null;
	items: NavItem[];
}

// Sidebar grouping shared by AdminShell and the command palette.
// The account page lives outside the nav: it is reachable through the
// sidebar identity row.
export const NAV_SECTIONS: NavSection[] = [
	{
		label: null,
		items: [
			{ sub: '', label: 'Dashboard', icon: LayoutDashboard },
			{ sub: '/chat', label: 'Chat', icon: MessageSquare }
		]
	},
	{
		label: 'Status',
		items: [
			{ sub: '/services', label: 'Services', icon: Activity, perm: 'status.manage' },
			{ sub: '/pages', label: 'Pages', icon: Files, perm: 'status.manage' },
			{ sub: '/incidents', label: 'Incidents', icon: Siren, perm: 'status.manage' },
			{ sub: '/maintenance', label: 'Maintenance', icon: Wrench, perm: 'status.manage' },
			{ sub: '/calendar', label: 'Calendar', icon: CalendarDays, perm: 'status.manage' },
			{ sub: '/customize', label: 'Customize', icon: Palette, perm: 'status.manage' },
			{ sub: '/notifications', label: 'Notifications', icon: Bell, perm: 'status.manage' }
		]
	},
	{
		label: 'Operations',
		items: [
			{ sub: '/agents', label: 'Systems', icon: Server, perm: 'agents.manage' },
			{ sub: '/deploy', label: 'Deployments', icon: Rocket, perm: 'deploy.view' },
			{ sub: '/groups', label: 'Groups', icon: Boxes, perm: 'groups.manage' },
			{ sub: '/teams', label: 'Teams', icon: UsersRound, perm: 'teams.manage' },
			{ sub: '/security', label: 'Security', icon: ShieldCheck, perm: 'scan.view' },
			{ sub: '/anomalies', label: 'Anomalies', icon: Radar, perm: 'anomaly.view' },
			{ sub: '/telemetry', label: 'Error tracking', icon: Bug, perm: 'telemetry.view' }
		]
	},
	{
		label: 'Administration',
		items: [
			{ sub: '/secrets', label: 'Secrets', icon: KeyRound, perm: 'secrets.manage' },
			{ sub: '/users', label: 'Users', icon: Users, perm: 'users.manage' },
			{ sub: '/audit', label: 'Audit log', icon: ScrollText, perm: 'audit.view' },
			{ sub: '/settings', label: 'Settings', icon: Settings, perm: 'admin.settings' },
			{ sub: '/account', label: 'Account', icon: CircleUser }
		]
	}
];

export function visibleSections(perms: string[]): NavSection[] {
	return NAV_SECTIONS.map((s) => ({
		label: s.label,
		items: s.items.filter((n) => !n.perm || perms.includes(n.perm))
	})).filter((s) => s.items.length > 0);
}
