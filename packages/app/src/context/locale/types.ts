import type { Accessor } from "solid-js"

export type LocalePreference = "system" | "en" | "zh-CN"
export type ActiveLocale = "en" | "zh-CN"
export type LocaleSource = "bootstrap-mirror" | "system" | "global-config" | "user" | "fallback"

export type ActivationCommit = () => void
export type ActivationFn = (locale: ActiveLocale) => Promise<void | ActivationCommit>

export interface LocaleEpoch {
  locale: ActiveLocale
  generation: number
}

export interface LocaleController {
  generation: Accessor<number>
  epoch(): LocaleEpoch
  preference: Accessor<LocalePreference>
  activeLocale: Accessor<ActiveLocale>
  source: Accessor<LocaleSource>
  pendingPreference: Accessor<LocalePreference | undefined>
  ready: Accessor<boolean>
  error: Accessor<Error | undefined>
  setActivation(fn: ActivationFn): void
  setPreference(pref: LocalePreference): Promise<boolean>
  reconcileGlobalPreference(pref: LocalePreference | undefined): Promise<void>
  bootstrap(): Promise<void>
}

export interface LocaleStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}
