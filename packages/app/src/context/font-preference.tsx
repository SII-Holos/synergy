import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"

export const DEFAULT_SANS_FONT_FAMILY = '"Inter", "Inter Fallback"'
export const DEFAULT_MONO_FONT_FAMILY = '"IBM Plex Mono", "IBM Plex Mono Fallback"'

export type FontKind = "sans" | "mono"
export type FontPhase = "idle" | "loading" | "ready" | "unsupported" | "denied"

type FontPreference = {
  requestedFamily: string
  appliedFamily: string
}

type FontPreferenceStore = {
  sans: FontPreference
  mono: FontPreference
}

type LocalFontData = {
  family?: string
  fullName?: string
}

type LocalFontQuery = (options?: { postscriptNames?: boolean }) => Promise<LocalFontData[]>

declare global {
  interface Window {
    queryLocalFonts?: LocalFontQuery
  }
}

const DEFAULT_PREFERENCES: FontPreferenceStore = {
  sans: { requestedFamily: "", appliedFamily: "" },
  mono: { requestedFamily: "", appliedFamily: "" },
}

// Solid stores wrap their initial value in place: setStore mutates the passed
// object, so a module-level default would leak state across provider instances
// (tests, HMR remounts). Always hand the store a private copy.
function defaultPreferences(): FontPreferenceStore {
  return {
    sans: { ...DEFAULT_PREFERENCES.sans },
    mono: { ...DEFAULT_PREFERENCES.mono },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function preference(value: unknown): FontPreference {
  if (!isRecord(value)) return { ...DEFAULT_PREFERENCES.sans }
  return {
    requestedFamily: typeof value.requestedFamily === "string" ? value.requestedFamily : "",
    appliedFamily: typeof value.appliedFamily === "string" ? value.appliedFamily : "",
  }
}

/**
 * Normalize any stored shape into the current { sans, mono } preference.
 * The persist layer runs this on every read, so it also guards against
 * hand-edited or partial storage.
 */
export function migrateFontPreferences(value: unknown): FontPreferenceStore {
  if (!isRecord(value)) return defaultPreferences()
  if ("sans" in value || "mono" in value) {
    return {
      sans: preference(value.sans),
      mono: preference(value.mono),
    }
  }
  return { sans: preference(value), mono: { ...DEFAULT_PREFERENCES.mono } }
}

export function normalizeFontFamily(value: string): string {
  return value.trim().replace(/\s+/g, " ")
}

export function isValidFontFamily(value: string): boolean {
  return value.length > 0 && !/[;,{}]/.test(value)
}

function defaultFamily(kind: FontKind): string {
  return kind === "mono" ? DEFAULT_MONO_FONT_FAMILY : DEFAULT_SANS_FONT_FAMILY
}

function cssVariable(kind: FontKind): string {
  return kind === "mono" ? "--font-family-mono" : "--font-family-sans"
}

function cssFeatureVariable(kind: FontKind): string {
  return kind === "mono" ? "--font-family-mono--font-feature-settings" : "--font-family-sans--font-feature-settings"
}

export function fontFamilyValue(family: string, kind: FontKind = "sans"): string {
  const escaped = family.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
  return `"${escaped}", ${defaultFamily(kind)}`
}

/**
 * Loads the locally installed font family names. Families are deduplicated and
 * sorted so the settings selector offers a manageable, predictable list.
 */
export async function loadLocalFontFamilies(): Promise<
  { status: "ok"; families: string[] } | { status: "unsupported" | "denied" }
> {
  if (typeof window === "undefined" || typeof window.queryLocalFonts !== "function") return { status: "unsupported" }

  try {
    const fonts = await window.queryLocalFonts()
    const families = [
      ...new Set(fonts.map((font) => normalizeFontFamily(font.family ?? "")).filter((family) => family.length > 0)),
    ].sort((a, b) => a.localeCompare(b))
    return { status: "ok", families }
  } catch (error) {
    return { status: error instanceof DOMException && error.name === "NotAllowedError" ? "denied" : "unsupported" }
  }
}

function applyFontFamily(kind: FontKind, family: string) {
  if (typeof document === "undefined") return
  const root = document.documentElement
  const next = family ? fontFamilyValue(family, kind) : ""
  // Avoid broadcasting a no-op change: listeners (Monaco, terminal, previews)
  // refresh on every event, so only fire when the value actually changes.
  if (root.style.getPropertyValue(cssVariable(kind)) === next) return
  if (family) {
    root.style.setProperty(cssVariable(kind), next)
    // Third-party families do not ship the default fonts' OpenType features.
    root.style.setProperty(cssFeatureVariable(kind), "normal")
  } else {
    root.style.removeProperty(cssVariable(kind))
    root.style.removeProperty(cssFeatureVariable(kind))
  }
  document.dispatchEvent(new CustomEvent("synergy:font-change", { detail: { kind } }))
}

export const { use: useFontPreference, provider: FontPreferenceProvider } = createSimpleContext({
  name: "FontPreference",
  init: () => {
    const [store, setStore, _, ready] = persisted(
      { ...Persist.global("font-preference", ["font-preference.v1"]), migrate: migrateFontPreferences },
      createStore<FontPreferenceStore>(defaultPreferences()),
    )

    // Per-kind UI phase: Check loads the local font list, then the user picks a
    // family from it and Apply uses it. The list is intentionally not
    // persisted; only the applied preference is.
    const [phase, setPhase] = createStore<Record<FontKind, FontPhase>>({ sans: "idle", mono: "idle" })
    const [fontList, setFontList] = createStore<Record<FontKind, string[]>>({ sans: [], mono: [] })
    const [selected, setSelected] = createStore<Record<FontKind, string>>({
      sans: store.sans.appliedFamily,
      mono: store.mono.appliedFamily,
    })

    // Monotonic request sequence per kind. Any reset or newer check
    // invalidates in-flight loads so stale results cannot clobber newer state.
    const requestSeq: Record<FontKind, number> = { sans: 0, mono: 0 }

    if (ready()) {
      applyFontFamily("sans", store.sans.appliedFamily)
      applyFontFamily("mono", store.mono.appliedFamily)
    }

    async function check(kind: FontKind): Promise<FontPhase> {
      const seq = ++requestSeq[kind]
      setPhase(kind, "loading")
      const result = await loadLocalFontFamilies()
      // A reset or newer check superseded this request: never clobber newer
      // state with a stale result.
      if (seq !== requestSeq[kind]) return phase[kind]
      if (result.status !== "ok") {
        setPhase(kind, result.status)
        return result.status
      }

      const applied = store[kind].appliedFamily
      let families = result.families
      if (applied && !families.includes(applied)) {
        families = [...families, applied].sort((a, b) => a.localeCompare(b))
      }
      setFontList(kind, families)
      if (applied) setSelected(kind, applied)
      setPhase(kind, "ready")
      return "ready"
    }

    function apply(kind: FontKind): boolean {
      if (phase[kind] !== "ready") return false
      const family = normalizeFontFamily(selected[kind])
      if (!family) return false
      setStore(kind, { requestedFamily: family, appliedFamily: family })
      applyFontFamily(kind, family)
      return true
    }

    function reset(kind: FontKind) {
      requestSeq[kind]++
      setStore(kind, { requestedFamily: "", appliedFamily: "" })
      setSelected(kind, "")
      setFontList(kind, [])
      setPhase(kind, "idle")
      applyFontFamily(kind, "")
    }

    function select(kind: FontKind, family: string) {
      setSelected(kind, family)
    }

    return {
      ready,
      phase: (kind: FontKind) => phase[kind],
      fontList: (kind: FontKind) => fontList[kind],
      selected: (kind: FontKind) => selected[kind],
      appliedFamily: (kind: FontKind) => store[kind].appliedFamily,
      check,
      apply,
      reset,
      select,
    }
  },
})
