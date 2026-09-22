// Reactive locale state for components. t() reads module state, so
// templates re-render when the locale changes. Server code must call
// translate() from ./index with event.locals.lang instead: this state
// is process-wide during SSR and only correct because initLocale runs
// synchronously at the top of each render via the root layout.
import { browser, dev } from '$app/environment';
import {
	DEFAULT_LOCALE,
	LANG_COOKIE,
	LANG_STORAGE_KEY,
	localeDir,
	normalizeLocale,
	translate,
	type I18nKey,
	type I18nParams
} from './index';
import {
	fmtDate as fmtDateRaw,
	fmtDateTime as fmtDateTimeRaw,
	relativeTime as relRaw
} from '$lib/utils/format';

let current = $state(DEFAULT_LOCALE);

export function getLocale(): string {
	return current;
}

/**
 * Set the render-time locale. Called from the root layout with
 * page.data.lang on every SSR render and hydration; pass undefined
 * outside that flow to land on en.
 */
export function initLocale(lang: string | undefined): void {
	current = normalizeLocale(lang) ?? DEFAULT_LOCALE;
}

/**
 * Switch the live locale. Persists to the wf-lang cookie so SSR
 * renders the same language on the next request, and to localStorage
 * as the admin-side preference store (no user prefs column exists).
 */
export function setLocale(lang: string): void {
	const l = normalizeLocale(lang);
	if (!l) {
		if (dev) console.warn(`[i18n] unsupported locale "${lang}"`);
		return;
	}
	current = l;
	if (browser) {
		localStorage.setItem(LANG_STORAGE_KEY, l);
		document.cookie = `${LANG_COOKIE}=${l};path=/;max-age=31536000;samesite=lax`;
		document.documentElement.lang = l;
		document.documentElement.dir = localeDir(l);
	}
}

/**
 * Post-mount preference sync: a stored choice wins over the SSR
 * locale when they differ. Runs inside a client $effect, after
 * hydration, so it cannot produce a markup mismatch.
 */
export function syncClientLocale(): void {
	const l = normalizeLocale(localStorage.getItem(LANG_STORAGE_KEY));
	if (l && l !== current) setLocale(l);
}

export function t(key: I18nKey, params?: I18nParams): string {
	return translate(current, key, params);
}

// Locale-aware wrappers over the utils/format helpers. Same names, so
// a component swaps the import source to opt in.
export function fmtDate(iso: string): string {
	return fmtDateRaw(iso, current);
}

export function fmtDateTime(iso: string): string {
	return fmtDateTimeRaw(iso, current);
}

export function relativeTime(isoOrMs: string | number, now = Date.now()): string {
	return relRaw(isoOrMs, now, current);
}
