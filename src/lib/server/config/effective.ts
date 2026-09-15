import type { StatusConfig, SectionKey } from './schema';
import { SECTION_KEYS } from './schema';
import { interpolateTrusted, validateConfigDoc } from './load';
import type { ConfigStore, SectionOverride } from './store';

/** Deterministic stringify for deep-equality checks on raw sections. */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function sectionsEqual(a: unknown, b: unknown): boolean {
	return stableStringify(a) === stableStringify(b);
}

export interface EffectiveConfig {
	/** Validated runtime config. */
	config: StatusConfig;
	/** Raw merged document (file base + overrides), pre-interpolation. */
	raw: Record<string, unknown>;
	/** Raw document as found in the TOML file. */
	fileRaw: Record<string, unknown>;
	/** Sections currently overridden in sqlite. */
	overrides: Map<string, SectionOverride>;
}

/**
 * Merge the file config with sqlite section overrides and validate the
 * result. A stored override replaces its whole top-level section.
 *
 * ${VAR} expansion applies to file content only. Overrides are panel
 * input: interpolating them would let any config-write permission read
 * arbitrary process env vars, so override values stay literal.
 * Placeholders must live in wharfinger.toml.
 */
export async function resolveEffective(
	fileRaw: Record<string, unknown>,
	store: ConfigStore,
	source = 'runtime config'
): Promise<EffectiveConfig> {
	const overrides = new Map((await store.all()).map((o) => [o.section, o]));
	const merged = validateMergedDoc(
		fileRaw,
		new Map([...overrides.entries()].map(([k, o]) => [k, o.raw])),
		source
	);
	const raw: Record<string, unknown> = { ...fileRaw };
	for (const [section, o] of overrides) {
		if ((SECTION_KEYS as readonly string[]).includes(section)) raw[section] = o.raw;
	}
	return { config: merged, raw, fileRaw, overrides };
}

/**
 * Validate a merged document: the file document interpolated, with
 * override sections layered on top verbatim. Used by the runtime, the
 * section save path, and the raw TOML editor.
 */
export function validateMergedDoc(
	fileRaw: Record<string, unknown>,
	overrides: ReadonlyMap<string, unknown>,
	source = 'config'
): StatusConfig {
	const resolved = interpolateTrusted(fileRaw, source);
	for (const [section, raw] of overrides) {
		if ((SECTION_KEYS as readonly string[]).includes(section)) resolved[section] = raw;
	}
	return validateConfigDoc(resolved, source);
}

/**
 * Decide whether saving `value` for `section` creates an override or
 * clears one. Returns null when the value matches the file and no
 * override exists (a no-op save).
 */
export function planSectionSave(
	fileRaw: Record<string, unknown>,
	overrides: Map<string, SectionOverride>,
	section: SectionKey,
	value: unknown
): 'store' | 'clear' | 'noop' {
	const fileValue = fileRaw[section];
	if (sectionsEqual(value, fileValue ?? undefined)) {
		return overrides.has(section) ? 'clear' : 'noop';
	}
	return 'store';
}

/**
 * Validate a candidate merged document without touching the runtime.
 * Returns the validated config or throws ConfigError.
 */
export function validateMerged(
	fileRaw: Record<string, unknown>,
	overrides: Map<string, SectionOverride>,
	section: SectionKey,
	value?: unknown
): StatusConfig {
	const resolved = interpolateTrusted(fileRaw, `section "${section}"`);
	for (const [key, o] of overrides) {
		if (key !== section && (SECTION_KEYS as readonly string[]).includes(key)) {
			resolved[key] = o.raw;
		}
	}
	// An absent value means the section is gone entirely, which is how
	// cross-section references detect a required section going missing.
	if (value === undefined) Reflect.deleteProperty(resolved, section);
	else resolved[section] = value;
	return validateConfigDoc(resolved, `section "${section}"`);
}
