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

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Restore file-level ${VAR} interpolation inside an override section.
 * Overrides are stored verbatim and never interpolated, so a
 * placeholder copied unchanged from the file would otherwise freeze
 * into a literal string and break validation. Only leaves
 * byte-identical to the file's own placeholder inherit the
 * interpolated value; a placeholder invented in the panel stays
 * literal, so overrides still cannot read arbitrary env vars.
 */
function inheritFileInterpolation(
	fileVal: unknown,
	resolvedVal: unknown,
	overrideVal: unknown
): unknown {
	if (typeof overrideVal === 'string' && overrideVal.includes('${') && overrideVal === fileVal) {
		return resolvedVal;
	}
	if (isPlainObject(overrideVal) && isPlainObject(fileVal)) {
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(overrideVal)) {
			out[k] = inheritFileInterpolation(
				fileVal[k],
				isPlainObject(resolvedVal) ? resolvedVal[k] : undefined,
				overrideVal[k]
			);
		}
		return out;
	}
	if (Array.isArray(overrideVal) && Array.isArray(fileVal)) {
		return overrideVal.map((v, i) =>
			inheritFileInterpolation(
				fileVal[i],
				Array.isArray(resolvedVal) ? resolvedVal[i] : undefined,
				v
			)
		);
	}
	return overrideVal;
}

/**
 * Validate a merged document: the file document interpolated, with
 * override sections layered on top verbatim except for unchanged
 * ${VAR} placeholders, which keep the file's interpolated value.
 * Used by the runtime, the section save path, and the raw TOML editor.
 */
export function validateMergedDoc(
	fileRaw: Record<string, unknown>,
	overrides: ReadonlyMap<string, unknown>,
	source = 'config'
): StatusConfig {
	const resolved = interpolateTrusted(fileRaw, source);
	for (const [section, raw] of overrides) {
		if ((SECTION_KEYS as readonly string[]).includes(section)) {
			resolved[section] = inheritFileInterpolation(fileRaw[section], resolved[section], raw);
		}
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
			resolved[key] = inheritFileInterpolation(fileRaw[key], resolved[key], o.raw);
		}
	}
	// An absent value means the section is gone entirely, which is how
	// cross-section references detect a required section going missing.
	if (value === undefined) Reflect.deleteProperty(resolved, section);
	else resolved[section] = inheritFileInterpolation(fileRaw[section], resolved[section], value);
	return validateConfigDoc(resolved, `section "${section}"`);
}
