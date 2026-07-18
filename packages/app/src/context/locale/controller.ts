import { createSignal } from "solid-js"
import type {
  LocaleController,
  LocaleEpoch,
  LocalePreference,
  ActiveLocale,
  LocaleSource,
  LocaleStorage,
  ActivationFn,
  LocaleSwitchResult,
} from "./types"
import { isLocalePreference } from "./types"

const STORAGE_KEY = "synergy-locale"

function activeLocaleForLanguage(language: string): ActiveLocale | undefined {
  const normalized = language.toLowerCase()
  if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-CN"
  if (normalized === "en" || normalized.startsWith("en-")) return "en"
  return undefined
}

function deriveActiveLocale(source: LocalePreference, navigatorLanguages: readonly string[]): ActiveLocale {
  if (source !== "system") return source
  for (const language of navigatorLanguages) {
    const locale = activeLocaleForLanguage(language)
    if (locale) return locale
  }
  return "en"
}

function toError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback)
}

export function createLocaleController(
  storage: LocaleStorage = localStorage,
  navigatorLanguages: readonly string[] = [],
): LocaleController {
  let activationFn: ActivationFn | undefined
  let systemLanguages = [...navigatorLanguages]
  let ticketId = 0

  function readMirror(): string | null {
    try {
      return storage.getItem(STORAGE_KEY)
    } catch {
      return null
    }
  }

  const rawMirror = readMirror()
  const initialPreference: LocalePreference =
    rawMirror !== null && rawMirror !== "" && isLocalePreference(rawMirror) ? rawMirror : "system"

  const [_generation, setGeneration] = createSignal(0)
  const [preference, setPreferenceState] = createSignal<LocalePreference>(initialPreference)
  const [activeLocale, setActiveLocaleState] = createSignal<ActiveLocale>(
    deriveActiveLocale(initialPreference, systemLanguages),
  )
  const [source, setSource] = createSignal<LocaleSource>("bootstrap-mirror")
  const [pendingPreference, setPendingPreference] = createSignal<LocalePreference | undefined>(undefined)
  const [ready, setReady] = createSignal(false)
  const [error, setError] = createSignal<Error | undefined>(undefined)

  function epoch(): LocaleEpoch {
    return { locale: activeLocale(), generation: _generation() }
  }

  function persistMirror(pref: LocalePreference): void {
    try {
      storage.setItem(STORAGE_KEY, pref)
    } catch {
      // The mirror is a best-effort bootstrap hint; global config remains authoritative.
    }
  }

  function isAborted(ticket: number): boolean {
    return ticket !== ticketId
  }

  async function commitActivation(locale: ActiveLocale, ticket: number): Promise<LocaleSwitchResult> {
    if (!activationFn) return { status: "failed", error: new Error("Locale activation is not configured") }
    try {
      const commit = await activationFn(locale)
      if (isAborted(ticket)) return { status: "superseded" }
      commit?.()
      return { status: "applied" }
    } catch (cause) {
      if (isAborted(ticket)) return { status: "superseded" }
      return { status: "failed", error: toError(cause, `Failed to activate locale: ${locale}`) }
    }
  }

  function commitPreferenceState(pref: LocalePreference, locale: ActiveLocale, nextSource: LocaleSource): void {
    persistMirror(pref)
    setPreferenceState(pref)
    setActiveLocaleState(locale)
    setSource(nextSource)
    setError(undefined)
    setGeneration((generation) => generation + 1)
    if (!ready()) setReady(true)
  }

  async function setPreference(pref: LocalePreference): Promise<LocaleSwitchResult> {
    if (!isLocalePreference(pref)) {
      const failure = new Error(`Unsupported locale preference: ${String(pref)}`)
      setError(failure)
      return { status: "failed", error: failure }
    }

    const ticket = ++ticketId
    const targetLocale = deriveActiveLocale(pref, systemLanguages)
    setPendingPreference(pref)

    const activation = await commitActivation(targetLocale, ticket)
    if (activation.status === "superseded") return activation
    if (activation.status === "failed") {
      if (pendingPreference() === pref) setPendingPreference(undefined)
      setError(activation.error)
      return activation
    }

    const nextSource = pendingPreference() === pref ? "user" : source()
    commitPreferenceState(pref, targetLocale, nextSource)
    return { status: "applied" }
  }

  async function reconcileGlobalPreference(pref: LocalePreference | undefined): Promise<void> {
    const effectivePreference = pref ?? "system"
    if (!isLocalePreference(effectivePreference)) return
    const authoritativeSource: LocaleSource = pref === undefined ? "system" : "global-config"
    const pending = pendingPreference()

    if (pending === effectivePreference) {
      setPendingPreference(undefined)
      setSource(authoritativeSource)
      return
    }

    if (pending !== undefined) return

    const ticket = ++ticketId
    const targetLocale = deriveActiveLocale(effectivePreference, systemLanguages)
    const activation = await commitActivation(targetLocale, ticket)
    if (activation.status === "superseded") return
    if (activation.status === "failed") {
      setError(activation.error)
      return
    }

    commitPreferenceState(effectivePreference, targetLocale, authoritativeSource)
  }

  async function rejectPendingPreference(
    expected: LocalePreference,
    authoritative: LocalePreference | undefined,
  ): Promise<boolean> {
    if (!isLocalePreference(expected) || pendingPreference() !== expected) return false
    const effectivePreference = authoritative ?? "system"
    if (!isLocalePreference(effectivePreference)) return false

    setPendingPreference(undefined)
    const authoritativeSource: LocaleSource = authoritative === undefined ? "system" : "global-config"
    const targetLocale = deriveActiveLocale(effectivePreference, systemLanguages)
    const ticket = ++ticketId
    const activation = await commitActivation(targetLocale, ticket)
    if (activation.status === "superseded") return false
    if (activation.status === "failed") {
      setError(activation.error)
      return false
    }

    commitPreferenceState(effectivePreference, targetLocale, authoritativeSource)
    return true
  }

  async function refreshSystemLanguages(languages: readonly string[]): Promise<void> {
    systemLanguages = [...languages]
    if (preference() !== "system") return

    const targetLocale = deriveActiveLocale("system", systemLanguages)
    if (targetLocale === activeLocale()) return

    const ticket = ++ticketId
    const activation = await commitActivation(targetLocale, ticket)
    if (activation.status === "superseded") return
    if (activation.status === "failed") {
      setError(activation.error)
      return
    }

    commitPreferenceState("system", targetLocale, "system")
  }

  async function bootstrap(): Promise<void> {
    const initialLocale = activeLocale()
    const activation = await commitActivation(initialLocale, ++ticketId)
    if (activation.status === "applied") {
      setReady(true)
      return
    }
    if (activation.status === "superseded") return

    const fallback = await commitActivation("en", ++ticketId)
    if (fallback.status === "applied") {
      setActiveLocaleState("en")
      setSource("fallback")
      setError(new Error("Bootstrap zh-CN catalog unavailable; falling back to en"))
      setReady(true)
      return
    }
    if (fallback.status === "failed") setError(fallback.error)
  }

  return {
    generation: _generation,
    epoch,
    preference,
    activeLocale,
    source,
    pendingPreference,
    ready,
    error,
    setActivation(fn: ActivationFn): void {
      activationFn = fn
    },
    setPreference,
    reconcileGlobalPreference,
    rejectPendingPreference,
    refreshSystemLanguages,
    bootstrap,
  }
}
