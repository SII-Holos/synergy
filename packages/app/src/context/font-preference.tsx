import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"

export const DEFAULT_SANS_FONT_FAMILY = '"Inter", "Inter Fallback"'
export const DEFAULT_MONO_FONT_FAMILY = '"IBM Plex Mono", "IBM Plex Mono Fallback"'

export type FontKind = "sans" | "mono"
export type FontDetectionStatus = "default" | "checking" | "applied" | "missing" | "unsupported" | "denied"

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

export function migrateFontPreferences(value: unknown): FontPreferenceStore {
  if (!isRecord(value)) return DEFAULT_PREFERENCES
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

function withoutStyleSuffix(value: string): string {
  return value.replace(
    /\s+(?:thin|extralight|ultralight|light|regular|book|medium|semibold|demibold|bold|extrabold|black|heavy|italic|oblique)$/i,
    "",
  )
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
  if (family) root.style.setProperty(cssVariable(kind), fontFamilyValue(family, kind))
  else root.style.removeProperty(cssVariable(kind))
  document.dispatchEvent(new CustomEvent("synergy:font-change", { detail: { kind } }))
}

export const { use: useFontPreference, provider: FontPreferenceProvider } = createSimpleContext({
  name: "FontPreference",
  init: () => {
    const [store, setStore, _, ready] = persisted(
      { ...Persist.global("font-preference", ["font-preference.v1"]), migrate: migrateFontPreferences },
      createStore<FontPreferenceStore>(DEFAULT_PREFERENCES),
    )
    const [sansStatus, setSansStatus] = createSignal<FontDetectionStatus>("default")
    const [monoStatus, setMonoStatus] = createSignal<FontDetectionStatus>("default")
    const [sansChecking, setSansChecking] = createSignal(false)
    const [monoChecking, setMonoChecking] = createSignal(false)

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

    async function checkAndApply(kind: FontKind) {
      const family = normalizeFontFamily(store[kind].requestedFamily)
      setChecking(kind, true)
      setStatus(kind, "checking")
      const result = await findLocalFontFamily(family)
      setChecking(kind, false)

      if (result === "found") {
        setStore(kind, "requestedFamily", family)
        setStore(kind, "appliedFamily", family)
        applyFontFamily(kind, family)
        setStatus(kind, "applied")
        return result
      }

      setStore(kind, "appliedFamily", "")
      applyFontFamily(kind, "")
      setStatus(kind, result)
      return result
    }

    function reset(kind: FontKind) {
      setStore(kind, { requestedFamily: "", appliedFamily: "" })
      applyFontFamily(kind, "")
      setStatus(kind, "default")
    }

    return {
      ready,
      family: (kind: FontKind) => store[kind].requestedFamily,
      appliedFamily: (kind: FontKind) => store[kind].appliedFamily,
      status: (kind: FontKind) => (kind === "sans" ? sansStatus() : monoStatus()),
      checking: (kind: FontKind) => (kind === "sans" ? sansChecking() : monoChecking()),
      setFamily(kind: FontKind, value: string) {
        setStore(kind, "requestedFamily", value)
        if (normalizeFontFamily(value) !== normalizeFontFamily(store[kind].appliedFamily)) {
          setStore(kind, "appliedFamily", "")
          applyFontFamily(kind, "")
          setStatus(kind, "default")
        }
      },
      checkAndApply,
      reset,
    }
  },
})
