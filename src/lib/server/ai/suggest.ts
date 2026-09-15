import type { Runtime } from '$lib/server/runtime';
import { sanitize } from './context';

/**
 * Suggested actions. The model proposes; a fixed catalog decides what
 * is even expressible, and every suggestion that carries an
 * executable call resolves to a real audited admin route. Nothing
 * runs without an authenticated user click on the target route.
 */

export interface Suggestion {
	kind: string;
	label: string;
	reason: string;
	/** Dangerous suggestions get an extra confirmation step in the UI. */
	danger: boolean;
	/** Prebuilt call for the UI to invoke on confirm; null = guidance. */
	call: { method: 'POST'; path: string; body: Record<string, unknown> } | null;
}

export const SUGGEST_KINDS = [
	'agent.service.restart',
	'agent.service.start',
	'agent.service.stop',
	'agent.packages.refresh',
	'agent.reboot',
	'deploy.redeploy',
	'deploy.rollback',
	'maintenance.open'
] as const;

export const SUGGEST_PROMPT = [
	'You propose operational actions for a Wharfinger status hub.',
	'From the CONTEXT block, suggest at most 3 actions that would help.',
	'Respond with ONLY a JSON object {"suggestions":[...]} — no prose.',
	'Each suggestion: {"kind": one of the listed kinds, "reason": short',
	'sentence, "agent": agent name if needed, "unit": service unit name',
	'if needed, "app": app name if needed, "service": service name if',
	'needed, "minutes": maintenance length if needed}.',
	'Kinds: ' + SUGGEST_KINDS.join(', ') + '.',
	'Prefer the least invasive action. If nothing helps, return an',
	'empty suggestions array.'
].join(' ');

const UNIT_RE = /^[a-zA-Z0-9@:._-]{1,128}$/;

interface RawSuggestion {
	kind?: unknown;
	reason?: unknown;
	agent?: unknown;
	unit?: unknown;
	app?: unknown;
	release?: unknown;
	service?: unknown;
	minutes?: unknown;
}

/** Extract the suggestions array from model output, tolerating prose. */
export function parseSuggestions(text: string): RawSuggestion[] {
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start < 0 || end <= start) return [];
	try {
		const parsed = JSON.parse(text.slice(start, end + 1)) as { suggestions?: unknown };
		if (!Array.isArray(parsed.suggestions)) return [];
		return parsed.suggestions
			.filter((s): s is RawSuggestion => typeof s === 'object' && s !== null)
			.slice(0, 5);
	} catch {
		return [];
	}
}

/**
 * Validate raw model suggestions against the catalog and resolve
 * names to ids. Anything unresolved or malformed is dropped.
 */
export async function resolveSuggestions(rt: Runtime, raw: RawSuggestion[]): Promise<Suggestion[]> {
	const out: Suggestion[] = [];
	const agents = await rt.agents.list();
	const agentByName = new Map(agents.map((a) => [a.name, a]));
	const apps = await rt.deploys.listApps();
	const appByName = new Map(apps.map((a) => [a.name, a]));
	const services = (await rt.snapshot.current()).snapshot.groups.flatMap((g) => g.services);
	const serviceByName = new Map(services.map((s) => [s.name, s]));

	const findAgent = (v: unknown) => {
		const s = sanitize(v, 80);
		return agents.find((a) => a.id === s) ?? agentByName.get(s) ?? null;
	};

	for (const r of raw) {
		const kind = sanitize(r.kind, 60);
		if (!(SUGGEST_KINDS as readonly string[]).includes(kind)) continue;
		const reason = sanitize(r.reason, 200);

		if (kind.startsWith('agent.service.')) {
			const agent = findAgent(r.agent);
			const unit = sanitize(r.unit, 128);
			if (!agent || !UNIT_RE.test(unit)) continue;
			const verb = kind.slice('agent.service.'.length);
			out.push({
				kind,
				label: `${verb} ${unit} on ${agent.name}`,
				reason,
				danger: verb !== 'start',
				call: {
					method: 'POST',
					path: `/agents/${agent.id}/task`,
					body: { action: `service.${verb}`, unit }
				}
			});
			continue;
		}
		if (kind === 'agent.packages.refresh' || kind === 'agent.reboot') {
			const agent = findAgent(r.agent);
			if (!agent) continue;
			out.push({
				kind,
				label:
					kind === 'agent.reboot'
						? `Reboot ${agent.name}`
						: `Refresh package index on ${agent.name}`,
				reason,
				danger: kind === 'agent.reboot',
				call: {
					method: 'POST',
					path: `/agents/${agent.id}/task`,
					body: { action: kind === 'agent.reboot' ? 'host.reboot' : 'packages.refresh' }
				}
			});
			continue;
		}
		if (kind === 'deploy.redeploy' || kind === 'deploy.rollback') {
			const appName = sanitize(r.app, 80);
			const app = apps.find((a) => a.id === appName) ?? appByName.get(appName);
			if (!app) continue;
			if (kind === 'deploy.rollback') {
				// The model names a release id or nothing; without a
				// valid prior release the suggestion degrades to guidance.
				const releases = await rt.deploys.releases(app.id, 10);
				const wanted = sanitize(r.release, 64);
				const rel = wanted
					? releases.find((x) => x.id === wanted || x.id.startsWith(wanted))
					: releases.find((x) => x.status !== 'live' && x.status !== 'failed');
				if (!rel) {
					out.push({
						kind,
						label: `Roll back ${app.name}`,
						reason: reason || 'No prior release found to roll back to',
						danger: true,
						call: null
					});
					continue;
				}
				out.push({
					kind,
					label: `Roll back ${app.name} to ${rel.id}`,
					reason,
					danger: true,
					call: {
						method: 'POST',
						path: `/deploy/apps/${app.id}/deploy`,
						body: { rollbackTo: rel.id }
					}
				});
				continue;
			}
			out.push({
				kind,
				label: `Redeploy ${app.name}`,
				reason,
				danger: false,
				call: { method: 'POST', path: `/deploy/apps/${app.id}/deploy`, body: {} }
			});
			continue;
		}
		if (kind === 'maintenance.open') {
			// Maintenance windows are config-section edits; the panel
			// owns that flow, so this suggestion stays guidance.
			const svc = serviceByName.get(sanitize(r.service, 80));
			const minutes = Math.min(Math.max(Math.round(Number(r.minutes) || 60), 5), 1440);
			out.push({
				kind,
				label: `Open a ${minutes}m maintenance window${svc ? ` for ${svc.name}` : ''}`,
				reason,
				danger: false,
				call: null
			});
		}
	}
	return out.slice(0, 5);
}
