# Frontend localization

Synergy Web and Desktop use one locale runtime for product-owned interface text, accessibility labels, and locale-sensitive formatting. The runtime supports English and Simplified Chinese and is designed so additional catalogs do not require a second state or rendering system.

## Locale model

The persisted preference is a closed global value:

```ts
type LocalePreference = "system" | "en" | "zh-CN"
```

`system` follows the client operating-system or browser locale. Any locale whose normalized language starts with `zh` resolves to `zh-CN`; all other unsupported locales resolve to `en`. The resolved active locale is always `en` or `zh-CN` and is written to `document.documentElement.lang`.

The preference belongs to global General configuration. Project Scope changes do not change the interface language. A local-storage mirror may select the catalog before the server configuration arrives, but global configuration is authoritative after synchronization. The mirror stores the original preference rather than a resolved locale.

## Runtime ownership

`packages/app` owns:

- locale preference and active-locale state
- bootstrap and global-config reconciliation
- catalog loading and activation
- the application `I18nProvider`
- cached `Intl` formatting helpers
- Settings integration and persistence

`packages/ui` consumes the same Lingui context through peer dependencies. It does not create an i18n instance, own catalogs, inspect browser language, import App contexts, or persist locale state. Its independent tests mount a test `I18nProvider`.

English is the source locale and the always-available fallback catalog. It is loaded with the initial application runtime. Simplified Chinese is a separate lazy catalog. A locale switch commits only after its target catalog loads; failed or stale loads cannot replace the current catalog. The product UI waits for bootstrap activation before rendering localized content so a Chinese startup does not flash English.

## Message contract

Every product message uses an explicit semantic ID:

```text
{domain}.{component}.{semanticKey}
```

Examples:

```text
settings.general.language.label
session.wake.status.active
ui.clipboard.copy
plugin.marketplace.empty.title
```

IDs describe product meaning rather than copying English text. Changing English wording does not change an ID unless the underlying meaning changes. Dynamic IDs and module-load translation calls are forbidden because they cannot be extracted or react to locale changes reliably.

Product code uses Lingui runtime descriptors and Solid components, not language branches or translation macros. Runtime descriptors carry a static `id`, English `message`, and an optional translator comment. ICU MessageFormat owns variables, plural/select behavior, and rich-text placeholders. Translations are never rendered as unsanitized HTML.

The tracked English and Simplified Chinese PO catalogs are generated and reconciled from source descriptors. Extraction preserves existing translations, updates source locations and comments, and removes obsolete entries. Strict compilation rejects missing translations and invalid ICU syntax.

## Formatting

Date, date-time, time, number, percentage, currency, list, and relative-time presentation derives from the active locale through cached native `Intl` formatters. Components do not pass hard-coded locale tags to `Intl` or `toLocale*` and do not use regional locale substitutions to imply unrelated preferences such as 24-hour time.

Business semantics remain unchanged: currency codes, model names, provider names, IDs, paths, and units still come from their owning domain. Locale changes only their presentation where appropriate.

## Translation boundary

Translate Synergy-owned interface text, including:

- navigation, Settings metadata, buttons, tooltips, placeholders, dialogs, and toasts
- loading, empty, disabled, reconnect, and error-wrapper states
- host-owned plugin Marketplace, consent, permission, and workbench chrome
- accessibility labels, image alternatives, and document titles

Do not translate:

- user, LLM, Note, Markdown, source-code, diff, terminal, or browser-page content
- plugin-author names, descriptions, contribution labels, changelogs, and custom UI text
- brands, model/provider/plugin IDs, paths, configuration keys, API error codes, and logs
- raw server or third-party error details; translate the Synergy wrapper and recovery action instead

## Tooling and verification

The App package owns catalog extraction and strict compilation. A repository localization contract scans App and UI TypeScript/TSX sources for hard-coded visible strings, Chinese source literals, hard-coded locale tags, invalid descriptors, dynamic IDs, and prohibited Lingui macro imports. Its structured allowlist is limited to reviewed non-translatable categories and exact occurrences.

A localization change is complete only when:

1. extraction leaves tracked catalogs unchanged
2. strict catalog compilation passes for English and Simplified Chinese
3. the localization contract reports no unclassified violations
4. App and UI tests and type checks pass
5. the App production build keeps Chinese in a lazy chunk and excludes development-only pseudo-localization
6. Web and Desktop checks verify cold start, switching, accessibility labels, narrow layout, and catalog-load failure behavior

The current runtime is client-rendered. Introducing server-side rendering requires an explicit server catalog preload and hydration design; the client bootstrap must not be assumed to satisfy SSR.
