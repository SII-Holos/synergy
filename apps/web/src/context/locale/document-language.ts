import type { ActiveLocale } from "./types"

export function applyDocumentLanguage(root: { lang: string }, locale: ActiveLocale): void {
  root.lang = locale
}
