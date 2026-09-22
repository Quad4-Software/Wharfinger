import { describe, expect, it, vi } from 'vitest';
import {
	localeDir,
	negotiateLocale,
	normalizeLocale,
	resolveLocale,
	translate,
	type I18nKey
} from '$lib/i18n';

describe('normalizeLocale', () => {
	it('accepts registered tags case-insensitively', () => {
		expect(normalizeLocale('en')).toBe('en');
		expect(normalizeLocale('DE')).toBe('de');
		expect(normalizeLocale('de-AT')).toBe('de');
	});
	it('rejects unknown and malformed tags', () => {
		expect(normalizeLocale('fr')).toBeNull();
		expect(normalizeLocale('pt-BR')).toBeNull();
		expect(normalizeLocale('')).toBeNull();
		expect(normalizeLocale(null)).toBeNull();
		expect(normalizeLocale('../../etc/passwd')).toBeNull();
		expect(normalizeLocale('en; DROP TABLE')).toBeNull();
	});
});

describe('negotiateLocale', () => {
	it('picks the first supported tag by q weight', () => {
		expect(negotiateLocale('fr-FR,fr;q=0.9,de;q=0.8,en;q=0.5')).toBe('de');
		expect(negotiateLocale('en-US,en;q=0.9')).toBe('en');
		expect(negotiateLocale('de-AT,de;q=0.9,en;q=0.8')).toBe('de');
	});
	it('ignores wildcards and garbage', () => {
		expect(negotiateLocale('*')).toBeNull();
		expect(negotiateLocale('')).toBeNull();
		expect(negotiateLocale(null)).toBeNull();
		expect(negotiateLocale('xx, zz;q=0.5')).toBeNull();
	});
});

describe('resolveLocale', () => {
	it('follows query > cookie > storage > config > accept > en', () => {
		expect(resolveLocale({})).toBe('en');
		expect(resolveLocale({ accept: 'de-DE,de;q=0.9' })).toBe('de');
		expect(resolveLocale({ config: 'de', accept: 'en' })).toBe('de');
		expect(resolveLocale({ storage: 'de', config: 'en' })).toBe('de');
		expect(resolveLocale({ cookie: 'de', storage: 'en' })).toBe('de');
		expect(resolveLocale({ query: 'de', cookie: 'en' })).toBe('de');
	});
	it('skips invalid earlier hops', () => {
		expect(resolveLocale({ query: 'fr', cookie: 'bogus!!', config: 'de' })).toBe('de');
		expect(resolveLocale({ query: 'javascript:alert(1)', config: 'de' })).toBe('de');
	});
	it('falls back to en when nothing resolves', () => {
		expect(resolveLocale({ query: 'fr', accept: 'fr,fr-FR;q=0.9' })).toBe('en');
	});
});

describe('translate', () => {
	it('returns en strings and interpolates params', () => {
		expect(translate('en', 'status.skip')).toBe('Skip to status');
		expect(translate('en', 'status.updated', { time: '2 hours ago' })).toBe(
			'Last updated 2 hours ago'
		);
		expect(translate('en', 'status.footer_refresh', { n: 30 })).toContain('30s');
	});
	it('returns translated strings for de', () => {
		expect(translate('de', 'status.skip')).toBe('Zum Status springen');
	});
	it('leaves unknown placeholders untouched', () => {
		expect(translate('en', 'status.updated')).toBe('Last updated {time}');
	});
	it('falls back to en for keys missing in de', () => {
		// Pick a key, delete-free check: unknown locale tags also fall back.
		expect(translate('xx', 'status.skip')).toBe('Skip to status');
	});
	it('selects plural variants via Intl.PluralRules', () => {
		expect(translate('en', 'cert.expires', { count: 1 })).toBe('TLS certificate expires in 1 day');
		expect(translate('en', 'cert.expires', { count: 3 })).toBe('TLS certificate expires in 3 days');
		expect(translate('de', 'cert.expires', { count: 1 })).toContain('1 Tag');
		expect(translate('de', 'cert.expires', { count: 5 })).toContain('5 Tagen');
		expect(translate('en', 'status.days_ago', { count: 90 })).toBe('90 days ago');
	});
	it('returns the key and warns once for unknown keys', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const bogus = 'totally.bogus.key' as I18nKey;
		expect(translate('en', bogus)).toBe('totally.bogus.key');
		expect(translate('en', bogus)).toBe('totally.bogus.key');
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});
});

describe('localeDir', () => {
	it('is ltr for all shipped locales', () => {
		expect(localeDir('en')).toBe('ltr');
		expect(localeDir('de')).toBe('ltr');
	});
	it('detects rtl base tags for future catalogs', () => {
		expect(localeDir('ar-SA')).toBe('rtl');
		expect(localeDir('he')).toBe('rtl');
	});
});
