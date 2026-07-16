import { createContext, useContext, createEffect, onMount, type ParentProps, type JSXElement } from "solid-js"
import { setupI18n as coreSetupI18n, type I18n } from "@lingui/core"
import { I18nProvider as LinguiI18nProvider } from "@lingui/solid"
import { createLocaleController } from "./controller"
import { createIntlFormatter, type IntlFormatter } from "./formatter"
import type { LocaleController } from "./types"

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

  const i18n = coreSetupI18n({
    locale: "en",
    locales: ["en", "zh-CN"],
    messages: { en: enMessages },
  })

  const fmt = createIntlFormatter(() => controller.activeLocale())

  async function activateCatalog(locale: string): Promise<void> {
    if (locale === "en") {
      i18n.loadAndActivate({ locale: "en", messages: enMessages })
      return
    }
    const messages = await zhLoader()
    i18n.loadAndActivate({ locale, messages })
  }

  function setHtmlLang(locale: string): void {
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale
    }
  }

  controller.setActivation(activateCatalog)

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
