import type { Runtime } from '$lib/server/runtime';
import { ConfigError } from '$lib/server/config/load';
import { planSectionSave, validateMerged } from '$lib/server/config/effective';
import type { SectionKey } from '$lib/server/config/schema';
import { SECTION_KEYS } from '$lib/server/config/schema';
import type { User } from './users';

export class SectionError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly issues?: string
	) {
		super(message);
	}
}

export interface SectionView {
	value: unknown;
	overridden: boolean;
	updatedAt: number | null;
	updatedBy: string | null;
}

export function sectionView(rt: Runtime, section: SectionKey): SectionView {
	const eff = rt.effective();
	const o = eff.overrides.get(section);
	return {
		value: section in eff.raw ? eff.raw[section] : undefined,
		overridden: o !== undefined,
		updatedAt: o?.updatedAt ?? null,
		updatedBy: o?.updatedBy ?? null
	};
}

/**
 * Persist a new raw value for a config section. The value is validated
 * in the fully-merged document (cross-section checks included), stored
 * only when it differs from the file, then pushed through the runtime
 * apply pipeline.
 */
export async function saveSectionValue(
	rt: Runtime,
	user: User,
	ip: string,
	section: SectionKey,
	value: unknown,
	expected?: number | null,
	action = 'config.section.save'
): Promise<{ applied: boolean; overridden: boolean; updatedAt: number | null }> {
	const eff = rt.effective();
	const current = eff.overrides.get(section)?.updatedAt ?? null;
	if (expected !== undefined && expected !== current) {
		throw new SectionError(409, 'this section was changed by someone else; reload and try again');
	}

	const plan = planSectionSave(eff.fileRaw, eff.overrides, section, value);
	try {
		const validated = validateMerged(
			eff.fileRaw,
			eff.overrides,
			section,
			plan === 'clear' ? undefined : value
		);
		if (!validated.admin.enabled) {
			throw new SectionError(
				422,
				'disabling the panel from inside itself would lock everyone out; set admin.enabled = false in wharfinger.toml or WHARFINGER_ADMIN_ENABLED=false instead'
			);
		}
	} catch (err) {
		if (err instanceof ConfigError) throw new SectionError(422, 'invalid config', err.message);
		throw err;
	}

	if (plan === 'store') await rt.configStore.set(section, value, user.username);
	else if (plan === 'clear') await rt.configStore.clear(section);
	await rt.reloadConfig();

	await rt.audit.log({
		userId: user.id,
		username: user.username,
		action,
		detail: `section=${section} ${plan}`,
		ip
	});
	const after = await rt.configStore.get(section);
	return { applied: true, overridden: after !== null, updatedAt: after?.updatedAt ?? null };
}

export async function resetSection(
	rt: Runtime,
	user: User,
	ip: string,
	section: SectionKey
): Promise<{ applied: boolean }> {
	const eff = rt.effective();
	try {
		const validated = validateMerged(eff.fileRaw, eff.overrides, section, undefined);
		if (!validated.admin.enabled) {
			throw new SectionError(
				422,
				'resetting would disable the panel and lock everyone out; edit wharfinger.toml or use WHARFINGER_ADMIN_ENABLED instead'
			);
		}
	} catch (err) {
		if (err instanceof ConfigError) {
			throw new SectionError(
				422,
				'cannot reset: other overrides depend on this section',
				err.message
			);
		}
		throw err;
	}
	await rt.configStore.clear(section);
	await rt.reloadConfig();
	await rt.audit.log({
		userId: user.id,
		username: user.username,
		action: 'config.section.reset',
		detail: `section=${section}`,
		ip
	});
	return { applied: true };
}

export function isSectionKey(v: string): v is SectionKey {
	return (SECTION_KEYS as readonly string[]).includes(v);
}
