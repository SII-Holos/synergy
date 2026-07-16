import { createContext, useContext, createEffect, onMount, type ParentProps, type JSXElement } from "solid-js"
import { setupI18n as coreSetupI18n, type I18n } from "@lingui/core"
import { I18nProvider as LinguiI18nProvider } from "@lingui/solid"
import { createLocaleController } from "./controller"
import { createIntlFormatter, type IntlFormatter } from "./formatter"
import type { ActiveLocale, LocaleController } from "./types"
import { shouldUsePseudoLocale } from "./pseudo"
import { applyDocumentLanguage } from "./document-language"

import { messages as enMessages } from "@/locales/en/messages.po?lingui"

const zhLoader = () => import("@/locales/zh-CN/messages.po?lingui").then((m) => m.messages as Record<string, string>)

export interface LocaleContextValue {
  controller: LocaleController
  i18n: I18n
  fmt: IntlFormatter
}

const LocaleContext = createContext<LocaleContextValue>()

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext)
  if (!ctx) throw new Error("useLocale must be used within a LocaleProvider")
  return ctx
}

function getNavigatorLanguages(): readonly string[] {
  if (typeof navigator !== "undefined" && navigator.languages?.length) return navigator.languages
  if (typeof navigator !== "undefined" && navigator.language) return [navigator.language]
  return []
}

export function LocaleProvider(props: ParentProps): JSXElement {
  const controller = createLocaleController(localStorage, getNavigatorLanguages())
  const pseudoEnabled =
    import.meta.env.DEV && typeof location !== "undefined" && shouldUsePseudoLocale(true, location.search)

  const i18n = coreSetupI18n({
    locale: "en",
    locales: pseudoEnabled ? ["en", "zh-CN", "pseudo"] : ["en", "zh-CN"],
    messages: { en: enMessages },
  })

  const fmt = createIntlFormatter(() => controller.activeLocale())

  async function prepareCatalogActivation(locale: string): Promise<() => void> {
    if (pseudoEnabled) {
      const messages = await import("@/locales/pseudo/messages.po?lingui").then(
        (module) => module.messages as Record<string, string>,
      )
      return () => i18n.loadAndActivate({ locale: "pseudo", messages })
    }
    if (locale === "en") {
      return () => i18n.loadAndActivate({ locale: "en", messages: enMessages })
    }
    const messages = await zhLoader()
    return () => i18n.loadAndActivate({ locale, messages })
  }

  function setHtmlLang(locale: ActiveLocale): void {
    if (typeof document !== "undefined") applyDocumentLanguage(document.documentElement, locale)
  }

  controller.setActivation(prepareCatalogActivation)

  onMount(async () => {
    await controller.bootstrap()
    const loc = controller.activeLocale()
    setHtmlLang(loc)
  })

  createEffect(() => {
    const loc = controller.activeLocale()
    if (!controller.ready()) return
    setHtmlLang(loc)
  })

  return (
    <LocaleContext.Provider value={{ controller, i18n, fmt }}>
      <LinguiI18nProvider i18n={i18n}>{controller.ready() ? props.children : null}</LinguiI18nProvider>
    </LocaleContext.Provider>
  )
}
