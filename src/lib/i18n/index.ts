// i18n core: catalogs, key lookup, interpolation, plural selection,
// and locale resolution. Pure module, safe for client and server.
// The reactive t() binding for components lives in locale.svelte.ts;
// see .agents/references/i18n.md for the full contract.
import { dev } from '$app/environment';
import type { DayState, ServiceStatus } from '$lib/shared/status';
import { en } from './locales/en';
import { de } from './locales/de';

export const DEFAULT_LOCALE = 'en';
export const LANG_COOKIE = 'wf-lang';
export const LANG_STORAGE_KEY = 'wf-lang';

type EnDict = typeof en;

type PluralSuffix = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';
// Base keys for pluralized entries: cert.expires_one/_other make
// cert.expires a valid argument to t() even though no bare
// cert.expires key exists.
type PluralBase<K> = K extends `${infer B}_${PluralSuffix}` ? B : never;
export type I18nKey = keyof EnDict | PluralBase<keyof EnDict>;
export type I18nParams = Record<string, string | number>;

type Dict = Partial<Record<keyof EnDict, string>>;

// Registered catalogs. A new language needs a file under locales/
// plus one entry here. Partial keeps index lookups honest: unknown
// tags yield undefined at runtime.
const CATALOGS: Partial<Record<string, Dict>> = { en, de };

export const LOCALES = Object.keys(CATALOGS);

// Display names for pickers; languages name themselves.
export const LOCALE_NAMES: Record<string, string> = {
	en: 'English',
	de: 'Deutsch'
};

// Base subtags that render right-to-left once such a catalog exists.
const RTL_BASES = new Set(['ar', 'he', 'fa', 'ur']);

export function localeDir(lang: string): 'ltr' | 'rtl' {
	return RTL_BASES.has(lang.split('-')[0].toLowerCase()) ? 'rtl' : 'ltr';
}

/** Normalize a raw BCP-47-ish tag to a supported locale, or null. */
export function normalizeLocale(raw: string | null | undefined): string | null {
	if (!raw) return null;
	const tag = raw.trim().toLowerCase().replace(/_/g, '-');
	if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(tag)) return null;
	if (CATALOGS[tag]) return tag;
	const base = tag.split('-')[0];
	return CATALOGS[base] ? base : null;
}

/** First supported tag in an Accept-Language header, or null. */
export function negotiateLocale(header: string | null | undefined): string | null {
	if (!header) return null;
	const ranked = header
		.split(',')
		.map((part) => {
			const [tag = '', q = ''] = part.trim().split(';');
			const qt = q.trim();
			const qv = qt.startsWith('q=') ? Number(qt.slice(2)) : 1;
			return { tag: tag.trim(), q: Number.isFinite(qv) ? qv : 0 };
		})
		.filter((p) => p.tag !== '' && p.tag !== '*')
		.sort((a, b) => b.q - a.q);
	for (const p of ranked) {
		const l = normalizeLocale(p.tag);
		if (l) return l;
	}
	return null;
}

export interface LocaleInputs {
	/** ?lang= override, public pages only. */
	query?: string | null;
	/** wf-lang cookie, written by setLocale. */
	cookie?: string | null;
	/** localStorage value, client only. */
	storage?: string | null;
	/** [page] locale from wharfinger.toml. */
	config?: string | null;
	/** Accept-Language header or navigator.language. */
	accept?: string | null;
}

/**
 * Resolution order: explicit per-request override, persisted user
 * preference, site config, browser language, then en. Every hop is
 * normalized against the registered catalogs, so an unsupported tag
 * never leaks through.
 */
export function resolveLocale(i: LocaleInputs): string {
	return (
		normalizeLocale(i.query) ??
		normalizeLocale(i.cookie) ??
		normalizeLocale(i.storage) ??
		normalizeLocale(i.config) ??
		negotiateLocale(i.accept) ??
		DEFAULT_LOCALE
	);
}

const warned = new Set<string>();

function pick(dict: Dict, key: string): string | undefined {
	return dict[key as keyof EnDict];
}

function pluralKey(locale: string, key: string, count: number): string | undefined {
	const cat: Intl.LDMLPluralRule = new Intl.PluralRules(locale).select(count);
	return (
		pick(CATALOGS[locale] ?? en, `${key}_${cat}`) ??
		pick(CATALOGS[locale] ?? en, `${key}_other`) ??
		pick(en, `${key}_${cat}`) ??
		pick(en, `${key}_other`)
	);
}

/**
 * Look up key in the locale catalog with en fallback, then apply
 * {name} interpolation. When params.count is a number the plural
 * variant key_<category> wins over the bare key. Missing keys warn
 * once in dev and render the key itself, never throw.
 */
export function translate(lang: string, key: I18nKey, params?: I18nParams): string {
	const locale = CATALOGS[lang] ? lang : DEFAULT_LOCALE;
	const dict = CATALOGS[locale] ?? en;
	let template: string | undefined;
	if (typeof params?.count === 'number') {
		template = pluralKey(locale, key, params.count);
	}
	template ??= pick(dict, key) ?? pick(en, key);
	if (template === undefined) {
		if (dev && !warned.has(key)) {
			warned.add(key);
			console.warn(`[i18n] missing key "${key}"`);
		}
		return key;
	}
	if (!params) return template;
	return template.replace(/\{(\w+)\}/g, (m, name: string) =>
		name in params ? String(params[name]) : m
	);
}

// Status enums stay untranslated in data; these maps pin each enum
// value to a catalog key so call sites keep literal, checkable keys.
export const STATUS_KEYS: Record<ServiceStatus, I18nKey> = {
	operational: 'pill.operational',
	maintenance: 'pill.maintenance',
	degraded: 'pill.degraded',
	partial_outage: 'pill.partial_outage',
	major_outage: 'pill.major_outage',
	unknown: 'pill.unknown'
};

export const OVERALL_KEYS: Record<ServiceStatus, I18nKey> = {
	operational: 'overall.operational',
	maintenance: 'overall.maintenance',
	degraded: 'overall.degraded',
	partial_outage: 'overall.partial_outage',
	major_outage: 'overall.major_outage',
	unknown: 'overall.unknown'
};

export const DAY_KEYS: Record<DayState, I18nKey> = {
	up: 'day.up',
	degraded: 'day.degraded',
	down: 'day.down',
	maintenance: 'day.maintenance',
	nodata: 'day.nodata'
};

// Partial because config data may carry a weekday token we do not
// know; callers fall back to the raw string.
export const WEEKDAY_KEYS: Partial<Record<string, I18nKey>> = {
	sun: 'weekday.sun',
	mon: 'weekday.mon',
	tue: 'weekday.tue',
	wed: 'weekday.wed',
	thu: 'weekday.thu',
	fri: 'weekday.fri',
	sat: 'weekday.sat'
};
