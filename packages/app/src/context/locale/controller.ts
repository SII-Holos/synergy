import { createSignal } from "solid-js"
import type {
  LocaleController,
  LocaleEpoch,
  LocalePreference,
  ActiveLocale,
  LocaleSource,
  LocaleStorage,
  ActivationFn,
} from "./types"

const STORAGE_KEY = "synergy-locale"
const VALID_PREFERENCES: ReadonlyArray<LocalePreference> = ["system", "en", "zh-CN"]

function isValidPreference(value: string): value is LocalePreference {
  return (VALID_PREFERENCES as readonly string[]).includes(value)
}

function deriveActiveLocale(source: LocalePreference, navigatorLanguages: readonly string[]): ActiveLocale {
  if (source !== "system") return source
  for (const lang of navigatorLanguages) {
    if (lang.toLowerCase().startsWith("zh")) return "zh-CN"
  }
  return "en"
}

export function createLocaleController(
  storage: LocaleStorage = localStorage,
  navigatorLanguages: readonly string[] = [],
): LocaleController {
  let activationFn: ActivationFn | undefined = undefined
  let ticketId = 0

  const rawMirror = storage.getItem(STORAGE_KEY)
  const initialPreference: LocalePreference =
    rawMirror !== null && rawMirror !== "" && isValidPreference(rawMirror) ? rawMirror : "system"

  const [_generation, setGeneration] = createSignal(0)
  const [preference, setPreferenceState] = createSignal<LocalePreference>(initialPreference)
  const [activeLocale, setActiveLocaleState] = createSignal<ActiveLocale>(
    deriveActiveLocale(initialPreference, navigatorLanguages),
  )
  const [source, setSource] = createSignal<LocaleSource>("bootstrap-mirror")
  const [pendingPreference, setPendingPreference] = createSignal<LocalePreference | undefined>(undefined)
  const [ready, setReady] = createSignal(false)
  const [error, setError] = createSignal<Error | undefined>(undefined)

  function epoch(): LocaleEpoch {
    return { locale: activeLocale(), generation: _generation() }
  }

  function persistMirror(pref: LocalePreference): void {
    storage.setItem(STORAGE_KEY, pref)
  }

  function isAborted(ticket: number): boolean {
    return ticket !== ticketId
  }

  async function commitActivation(locale: ActiveLocale, ticket: number): Promise<boolean> {
    if (!activationFn) return false
    try {
      const commit = await activationFn(locale)
      if (isAborted(ticket)) return false
      commit?.()
      return true
    } catch {
      return false
    }
  }

  async function setPreference(pref: LocalePreference): Promise<boolean> {
    const ticket = ++ticketId
    const targetLocale = deriveActiveLocale(pref, navigatorLanguages)

    setPendingPreference(pref)

    const ok = await commitActivation(targetLocale, ticket)
    if (!ok) {
      if (isAborted(ticket)) return false
      setPendingPreference(undefined)
      setError(new Error(`Failed to activate locale: ${pref}`))
      return false
    }
    if (isAborted(ticket)) return false

    persistMirror(pref)
    setPreferenceState(pref)
    setActiveLocaleState(targetLocale)
    if (pendingPreference() !== undefined) setSource("user")
    setError(undefined)
    setGeneration((g) => g + 1)
    if (!ready()) setReady(true)
    return true
  }

  async function reconcileGlobalPreference(pref: LocalePreference | undefined): Promise<void> {
    const effectivePreference = pref ?? "system"
    const authoritativeSource: LocaleSource = pref === undefined ? "system" : "global-config"
    const pending = pendingPreference()

    if (pending === effectivePreference) {
      setPendingPreference(undefined)
      setSource(authoritativeSource)
      return
    }

    if (pending !== undefined && pending !== effectivePreference) return

    const ticket = ++ticketId
    const targetLocale = deriveActiveLocale(effectivePreference, navigatorLanguages)
    const ok = await commitActivation(targetLocale, ticket)
    if (!ok) {
      if (isAborted(ticket)) return
      setError(new Error(`Failed to activate global config locale: ${effectivePreference}`))
      return
    }
    if (isAborted(ticket)) return

    persistMirror(effectivePreference)
    setPreferenceState(effectivePreference)
    setActiveLocaleState(targetLocale)
    setSource(authoritativeSource)
    setError(undefined)
    setGeneration((g) => g + 1)
    if (!ready()) setReady(true)
  }

  async function bootstrap(): Promise<void> {
    const initialLocale = activeLocale()
    const ok = await commitActivation(initialLocale, ++ticketId)
    if (ok) {
      setReady(true)
      return
    }
    const fallbackOk = await commitActivation("en", ++ticketId)
    if (fallbackOk) {
      setActiveLocaleState("en")
      setSource("fallback")
      setError(new Error("Bootstrap zh-CN catalog unavailable; falling back to en"))
      setReady(true)
    }
  }

  const ctrl: LocaleController = {
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
    bootstrap,
  }

  return ctrl
}
