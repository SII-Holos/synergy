import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"

export const DEFAULT_SANS_FONT_FAMILY = '"Inter", "Inter Fallback"'
export const DEFAULT_MONO_FONT_FAMILY = '"IBM Plex Mono", "IBM Plex Mono Fallback"'

export type FontKind = "sans" | "mono"
export type FontDetectionStatus = "default" | "editing" | "checking" | "applied" | "missing" | "unsupported" | "denied"

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

const STYLE_SUFFIX_PATTERN =
  /\s+(?:thin|extralight|ultralight|light|regular|book|medium|semibold|demibold|bold|extrabold|black|heavy|italic|oblique|常规|斜体|粗体|细体|特粗|特细|中黑|中等|书宋|黑体)$/i

function withoutStyleSuffix(value: string): string {
  return value.replace(STYLE_SUFFIX_PATTERN, "")
}

function matchesFontName(value: string | undefined, wanted: string): boolean {
  if (!value) return false
  const normalized = normalizeFontFamily(value).toLocaleLowerCase()
  return normalized === wanted || withoutStyleSuffix(normalized) === withoutStyleSuffix(wanted)
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

export async function findLocalFontFamily(family: string): Promise<"found" | "missing" | "unsupported" | "denied"> {
  const normalized = normalizeFontFamily(family)
  if (!isValidFontFamily(normalized)) return "missing"

  if (typeof window === "undefined" || typeof window.queryLocalFonts !== "function") return "unsupported"

  try {
    const fonts = await window.queryLocalFonts()
    const wanted = normalized.toLocaleLowerCase()
    return fonts.some((font) => matchesFontName(font.family, wanted) || matchesFontName(font.fullName, wanted))
      ? "found"
      : "missing"
  } catch (error) {
    return error instanceof DOMException && error.name === "NotAllowedError" ? "denied" : "unsupported"
  }
}

function applyFontFamily(kind: FontKind, family: string) {
  if (typeof document === "undefined") return
  const root = document.documentElement
  if (family) {
    root.style.setProperty(cssVariable(kind), fontFamilyValue(family, kind))
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

    // The input draft is intentionally NOT persisted: typing must not write
    // localStorage on every keystroke. Only verified (applied) preferences and
    // the last verified requested name are persisted, on check/reset.
    const [sansDraft, setSansDraft] = createSignal(store.sans.requestedFamily)
    const [monoDraft, setMonoDraft] = createSignal(store.mono.requestedFamily)
    const [sansStatus, setSansStatus] = createSignal<FontDetectionStatus>("default")
    const [monoStatus, setMonoStatus] = createSignal<FontDetectionStatus>("default")
    const [sansChecking, setSansChecking] = createSignal(false)
    const [monoChecking, setMonoChecking] = createSignal(false)

    // Monotonic request sequence per kind. Any user input, reset, or newer
    // check invalidates in-flight checks so stale results cannot clobber
    // newer state.
    const requestSeq: Record<FontKind, number> = { sans: 0, mono: 0 }

    if (ready()) {
      applyFontFamily("sans", store.sans.appliedFamily)
      applyFontFamily("mono", store.mono.appliedFamily)
      setSansStatus(store.sans.appliedFamily ? "applied" : "default")
      setMonoStatus(store.mono.appliedFamily ? "applied" : "default")
    }

    function setStatus(kind: FontKind, status: FontDetectionStatus) {
      if (kind === "sans") setSansStatus(status)
      else setMonoStatus(status)
    }

    function setChecking(kind: FontKind, value: boolean) {
      if (kind === "sans") setSansChecking(value)
      else setMonoChecking(value)
    }

    function setDraft(kind: FontKind, value: string) {
      if (kind === "sans") setSansDraft(value)
      else setMonoDraft(value)
    }

    async function checkAndApply(kind: FontKind): Promise<FontDetectionStatus> {
      const family = normalizeFontFamily(kind === "sans" ? sansDraft() : monoDraft())
      // Empty input means "use default": treat Check as a reset.
      if (!family) {
        reset(kind)
        return "default"
      }

      const seq = ++requestSeq[kind]
      setChecking(kind, true)
      setStatus(kind, "checking")
      const result = await findLocalFontFamily(family)
      // A newer input, reset, or check superseded this request: never clobber
      // newer state with a stale result.
      if (seq !== requestSeq[kind]) return result === "found" ? "applied" : result
      setChecking(kind, false)

      if (result === "found") {
        setStore(kind, "requestedFamily", family)
        setStore(kind, "appliedFamily", family)
        applyFontFamily(kind, family)
        setStatus(kind, "applied")
        return "applied"
      }

      // Keep the previously applied font (if any) and only report the failure.
      setStatus(kind, result)
      return result
    }

    function reset(kind: FontKind) {
      requestSeq[kind]++
      setChecking(kind, false)
      setDraft(kind, "")
      setStore(kind, { requestedFamily: "", appliedFamily: "" })
      applyFontFamily(kind, "")
      setStatus(kind, "default")
    }

    return {
      ready,
      family: (kind: FontKind) => (kind === "sans" ? sansDraft() : monoDraft()),
      appliedFamily: (kind: FontKind) => store[kind].appliedFamily,
      status: (kind: FontKind) => (kind === "sans" ? sansStatus() : monoStatus()),
      checking: (kind: FontKind) => (kind === "sans" ? sansChecking() : monoChecking()),
      setFamily(kind: FontKind, value: string) {
        // Typing cancels in-flight checks: the user has moved on. The draft is
        // not persisted and the applied font is never disturbed while typing.
        requestSeq[kind]++
        setChecking(kind, false)
        setDraft(kind, value)
        const normalized = normalizeFontFamily(value)
        const applied = normalizeFontFamily(store[kind].appliedFamily)
        if (normalized === applied) setStatus(kind, applied ? "applied" : "default")
        else setStatus(kind, "editing")
      },
      checkAndApply,
      reset,
    }
  },
})
