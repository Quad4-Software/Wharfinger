import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'smol-toml';
import * as v from 'valibot';
import { Config, type StatusConfig } from './schema';

const DEFAULT_CONFIG_PATH = 'config/wharfinger.toml';

function configPath(): string {
	return resolve(process.env.WHARFINGER_CONFIG ?? DEFAULT_CONFIG_PATH);
}

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Expand ${VAR} and ${VAR:-default} references in every string of the
 * parsed document. Throws listing all missing variables so operators get
 * one complete error instead of a stream of failures.
 */
export function interpolateEnv(input: unknown, missing: string[] = []): unknown {
	if (typeof input === 'string') {
		return input.replace(ENV_REF, (_m, name: string, fallback: string | undefined) => {
			const val = process.env[name];
			if (val !== undefined && val !== '') return val;
			if (fallback !== undefined) return fallback;
			if (val !== undefined) return val;
			missing.push(name);
			return _m;
		});
	}
	if (Array.isArray(input)) return input.map((i) => interpolateEnv(i, missing));
	if (input !== null && typeof input === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, val] of Object.entries(input)) out[k] = interpolateEnv(val, missing);
		return out;
	}
	return input;
}

/**
 * Read and TOML-parse the config file without env interpolation or
 * validation. The raw document is what the admin panel edits, so
 * ${VAR} placeholders survive round-trips.
 */
export function loadRawConfig(path = configPath()): Record<string, unknown> {
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch {
		throw new ConfigError(`cannot read config file: ${path}`);
	}
	try {
		const raw: unknown = parse(text);
		if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
			throw new ConfigError(`invalid TOML document in ${path}`);
		}
		return raw as Record<string, unknown>;
	} catch (err) {
		if (err instanceof ConfigError) throw err;
		throw new ConfigError(`invalid TOML in ${path}: ${(err as Error).message}`);
	}
}

/**
 * Interpolate a trusted document, failing on unresolved references.
 * Only the TOML file counts as trusted: values that arrive through the
 * admin panel or sqlite overrides must never expand ${VAR}, otherwise
 * any delegated config-write permission could read every process
 * environment variable.
 */
export function interpolateTrusted(raw: unknown, source = 'config'): Record<string, unknown> {
	const missing: string[] = [];
	const interpolated = interpolateEnv(raw, missing) as Record<string, unknown>;
	if (missing.length > 0) {
		throw new ConfigError(
			`missing environment variables referenced in ${source}: ${[...new Set(missing)].join(', ')}`
		);
	}
	return interpolated;
}

/** Schema-validate an already-interpolated document. */
export function validateConfigDoc(doc: unknown, source = 'config'): StatusConfig {
	const result = v.safeParse(Config, doc);
	if (!result.success) {
		const issues = result.issues.map((i) => `  ${formatPath(i)}: ${i.message}`).join('\n');
		throw new ConfigError(`invalid config in ${source}:\n${issues}`);
	}
	return result.output;
}

/** Interpolate + validate a raw document into a StatusConfig. */
function validateRawConfig(raw: unknown, source = 'config'): StatusConfig {
	return validateConfigDoc(interpolateTrusted(raw, source), source);
}

export function loadConfig(path = configPath()): StatusConfig {
	return validateRawConfig(loadRawConfig(path), path);
}

function formatPath(issue: v.InferIssue<typeof Config>): string {
	if (!issue.path || issue.path.length === 0) return '(root)';
	return issue.path
		.map((p) => (typeof p.key === 'number' ? `[${p.key}]` : `.${String(p.key)}`))
		.join('')
		.replace(/^\./, '');
}

export class ConfigError extends Error {
	readonly isConfigError = true;
}
