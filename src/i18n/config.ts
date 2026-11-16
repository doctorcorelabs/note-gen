// Modified for the web fork on 2026-11-14; see FORK.md.
import type { AbstractIntlMessages } from 'next-intl';

export const SUPPORTED_LOCALES = ['en', 'zh'] as const;
export type SupportedLocale = string;

export const DEFAULT_LOCALE: SupportedLocale = 'en';
// The zh catalog is the source of truth for message fallback: keys missing
// from any locale resolve to zh strings. Keep this separate from
// DEFAULT_LOCALE so changing the default UI language never changes which
// catalog backs the fallback merge or override validation.
export const FALLBACK_LOCALE: SupportedLocale = 'zh';
export const LANGUAGE_STORAGE_KEY = 'app-language';

export function isSupportedLocale(locale: string): locale is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(locale) || getPluginLanguages().some(x => x.value === locale);
}

export function normalizeLocale(locale?: string | null): SupportedLocale {
  if (locale && isSupportedLocale(locale)) {
    return locale;
  }

  return DEFAULT_LOCALE;
}

/**
 * Map an active locale to a safe BCP 47 value for an HTML `lang`
 * attribute (decision D-6: export templates follow the active
 * locale). The fork locale `zh` maps to `zh-CN`, matching the
 * plugin localization mapping. Bare language tags pass through
 * lowercased; language-region tags pass through with the region
 * uppercased. Anything else (display names, empty values, or
 * strings that cannot be a language tag) falls back to `en`, so
 * the result is always safe to interpolate into an attribute.
 */
export function toHtmlLangTag(locale?: string | null): string {
  const trimmed = locale?.trim() ?? '';
  if (trimmed === 'zh' || trimmed.toLowerCase() === 'zh-cn') {
    return 'zh-CN';
  }
  const bareLanguage = /^[a-z]{2,3}$/i.exec(trimmed);
  if (bareLanguage) {
    return bareLanguage[0].toLowerCase();
  }
  const languageRegion = /^([a-z]{2,3})-([a-z]{2}|[0-9]{3})$/i.exec(trimmed);
  if (languageRegion) {
    return `${languageRegion[1].toLowerCase()}-${languageRegion[2].toUpperCase()}`;
  }
  return DEFAULT_LOCALE;
}

function isMessageObject(value: unknown): value is AbstractIntlMessages {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function mergeMessages(
  messages: AbstractIntlMessages,
  fallbackMessages: AbstractIntlMessages
): AbstractIntlMessages {
  const merged: AbstractIntlMessages = { ...messages };

  for (const [key, fallbackValue] of Object.entries(fallbackMessages)) {
    const currentValue = merged[key];

    if (isMessageObject(currentValue) && isMessageObject(fallbackValue)) {
      merged[key] = mergeMessages(currentValue, fallbackValue);
      continue;
    }

    if (currentValue === undefined) {
      merged[key] = fallbackValue;
    }
  }

  return merged;
}

export async function loadLocaleMessages(locale: SupportedLocale): Promise<AbstractIntlMessages> {
  // Keep the import map explicit so external language packs are never bundled.
  const loaders = {
    en: async () => {
      const [{ default: messages }, { default: common }] = await Promise.all([
        import('../../messages/en.json'),
        import('../../messages/common/en.json'),
      ]);
      return { ...messages, common };
    },
    zh: async () => {
      const [{ default: messages }, { default: common }] = await Promise.all([
        import('../../messages/zh.json'),
        import('../../messages/common/zh.json'),
      ]);
      return { ...messages, common };
    },
  };
  return loaders[locale === 'en' ? 'en' : 'zh']();
}

export async function loadMessagesWithFallback(
  locale: SupportedLocale
): Promise<AbstractIntlMessages> {
  const fallback = await loadLocaleMessages(FALLBACK_LOCALE);
  let messages = locale === FALLBACK_LOCALE
    ? fallback
    : mergeMessages(await loadLocaleMessages('en'), fallback);

  for (const [, languages] of [...pluginLanguages].sort(([a], [b]) => b.localeCompare(a))) {
    for (const language of languages) {
      if (language.locale === locale) messages = mergeMessages(language.messages, messages);
    }
  }
  return messages;
}

export const PLUGIN_LANGUAGES_CHANGED = 'notegen:languages-changed'
interface RegisteredLanguage { locale: string; name: string; messages: AbstractIntlMessages }
const pluginLanguages = new Map<string, RegisteredLanguage[]>()
export function getPluginLanguages() {
  const byLocale = new Map<string, { value: string; label: string }>()
  for (const [, languages] of [...pluginLanguages].sort(([a], [b]) => a.localeCompare(b))) {
    for (const language of languages) if (!byLocale.has(language.locale)) byLocale.set(language.locale, { value: language.locale, label: language.name })
  }
  return [...byLocale.values()]
}
function languageChange() { if (typeof window !== 'undefined') window.dispatchEvent(new Event(PLUGIN_LANGUAGES_CHANGED)) }
export function registerPluginLanguages(id: string, languages: RegisteredLanguage[]) { pluginLanguages.set(id, languages); languageChange() }
export function unregisterPluginLanguages(id: string) { if (pluginLanguages.delete(id)) languageChange() }

export async function validateLanguageOverrides(messages: AbstractIntlMessages) {
  const { parse } = await import('@formatjs/icu-messageformat-parser')
  const fallback = await loadLocaleMessages(FALLBACK_LOCALE)
  const signature = (text: string) => {
    const argumentsUsed = new Set<string>()
    const walk = (nodes: ReturnType<typeof parse>) => {
      for (const node of nodes) {
        if (node.type !== 0 && node.type !== 7) argumentsUsed.add(`${node.type === 8 ? 'tag' : 'arg'}:${node.value}`)
        if ('options' in node) for (const option of Object.values(node.options)) walk(option.value)
        if ('children' in node) walk(node.children)
      }
    }
    walk(parse(text))
    return [...argumentsUsed].sort().join('|')
  }
  const walk = (values: AbstractIntlMessages, base: AbstractIntlMessages) => {
    for (const [key, value] of Object.entries(values)) {
      const original = base[key]
      if (typeof value === 'string') {
        // Unchanged source literals (including Mermaid code) need no ICU parsing.
        if (value === original) continue
        const actual = signature(value)
        if (original !== undefined && (typeof original !== 'string' || signature(original) !== actual)) throw new Error(`Translation placeholders do not match: ${key}`)
      } else {
        if (typeof original === 'string') throw new Error(`Translation shape does not match: ${key}`)
        walk(value, original ?? {})
      }
    }
  }
  walk(messages, fallback)
}
