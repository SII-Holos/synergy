import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

// The real @ericsanchezok/synergy-ui/context helper uses JSX which bun's test
// transform compiles to React.createElement in this harness. Substitute a plain
// JS-free createSimpleContext so we can exercise the provider logic directly.
let currentApi: unknown
mock.module("@ericsanchezok/synergy-ui/context", () => ({
  createSimpleContext: (input: { name: string; init: () => unknown }) => ({
    provider: (props: { children?: unknown }) => {
      currentApi ??= input.init()
      return props.children
    },
    use: () => currentApi,
  }),
}))

const { FontPreferenceProvider, useFontPreference } = await import("../../src/context/font-preference")

type FontApi = ReturnType<typeof useFontPreference>

function mountProvider() {
  return FontPreferenceProvider({ children: null }) as unknown
}

function setLocalFonts(fonts: Array<{ family?: string; fullName?: string }>) {
  window.queryLocalFonts = async () => fonts
}

beforeEach(() => {
  localStorage.clear()
  currentApi = undefined
  document.documentElement.removeAttribute("style")
})

afterEach(() => {
  currentApi = undefined
  document.body.replaceChildren()
  delete (window as unknown as { queryLocalFonts?: unknown }).queryLocalFonts
})

describe("font preference provider interaction model (check/apply)", () => {
  test("migrates the legacy localStorage key into the global persisted store", () => {
    localStorage.setItem(
      "font-preference.v1",
      JSON.stringify({ requestedFamily: "Legacy Font", appliedFamily: "Legacy Font" }),
    )

    mountProvider()
    const font = currentApi as FontApi

    expect(font.appliedFamily("sans")).toBe("Legacy Font")
    expect(font.selected("sans")).toBe("Legacy Font")
    expect(localStorage.getItem("font-preference.v1")).toBeNull()
    expect(localStorage.getItem("synergy.global.dat:font-preference")).toContain('"Legacy Font"')
  })

  test("check loads and sorts the local font list and enters ready phase", async () => {
    setLocalFonts([
      { family: "Zapf Dingbats", fullName: "Zapf Dingbats" },
      { family: "Arial", fullName: "Arial" },
      { family: "LXGW WenKai", fullName: "霞鹜文楷 Regular" },
    ])
    mountProvider()
    const font = currentApi as FontApi

    expect(font.phase("sans")).toBe("idle")
    const phase = await font.check("sans")
    expect(phase).toBe("ready")
    expect(font.phase("sans")).toBe("ready")
    expect(font.fontList("sans")).toEqual(["Arial", "LXGW WenKai", "Zapf Dingbats"])
  })

  test("select then apply persists and applies the chosen font", async () => {
    let events = 0
    document.addEventListener("synergy:font-change", () => events++)
    setLocalFonts([{ family: "Arial", fullName: "Arial" }])
    mountProvider()
    const font = currentApi as FontApi
    await font.check("sans")

    font.select("sans", "Arial")
    const applied = font.apply("sans")
    expect(applied).toBe(true)
    expect(font.appliedFamily("sans")).toBe("Arial")
    expect(font.phase("sans")).toBe("ready")
    expect(document.documentElement.style.getPropertyValue("--font-family-sans")).toContain('"Arial"')
    expect(events).toBe(1)
  })

  test("apply is a no-op before check or without a selection", async () => {
    setLocalFonts([{ family: "Arial", fullName: "Arial" }])
    mountProvider()
    const font = currentApi as FontApi

    // idle: apply must not apply anything
    font.select("sans", "Arial")
    expect(font.apply("sans")).toBe(false)
    expect(font.appliedFamily("sans")).toBe("")

    await font.check("sans")
    // ready but nothing selected
    font.select("sans", "")
    expect(font.apply("sans")).toBe(false)
    expect(font.appliedFamily("sans")).toBe("")
  })

  test("reset clears applied font, list, selection, and returns to idle", async () => {
    setLocalFonts([{ family: "Arial", fullName: "Arial" }])
    mountProvider()
    const font = currentApi as FontApi
    await font.check("sans")
    font.select("sans", "Arial")
    font.apply("sans")
    expect(font.appliedFamily("sans")).toBe("Arial")

    font.reset("sans")
    expect(font.appliedFamily("sans")).toBe("")
    expect(font.phase("sans")).toBe("idle")
    expect(font.fontList("sans")).toEqual([])
    expect(font.selected("sans")).toBe("")
    expect(document.documentElement.style.getPropertyValue("--font-family-sans")).toBe("")
  })

  test("a stale check result does not clobber a reset", async () => {
    let resolveFonts!: (fonts: Array<{ family?: string; fullName?: string }>) => void
    window.queryLocalFonts = () =>
      new Promise((resolve) => {
        resolveFonts = resolve
      })
    mountProvider()
    const font = currentApi as FontApi
    const pending = font.check("sans")
    font.reset("sans")
    expect(font.phase("sans")).toBe("idle")

    resolveFonts([{ family: "Arial", fullName: "Arial" }])
    const phase = await pending
    // The reset invalidated the in-flight check; its result is discarded.
    expect(phase).toBe("idle")
    expect(font.phase("sans")).toBe("idle")
    expect(font.fontList("sans")).toEqual([])
  })

  test("already applied family is pre-selected and kept in the list", async () => {
    setLocalFonts([{ family: "Arial", fullName: "Arial" }])
    mountProvider()
    const font = currentApi as FontApi
    await font.check("sans")
    font.select("sans", "Arial")
    font.apply("sans")

    // Re-check: applied family must still be selected and present.
    setLocalFonts([
      { family: "Arial", fullName: "Arial" },
      { family: "Helvetica", fullName: "Helvetica" },
    ])
    await font.check("sans")
    expect(font.selected("sans")).toBe("Arial")
    expect(font.fontList("sans")).toContain("Arial")
  })

  test("unsupported phase when queryLocalFonts is unavailable", async () => {
    delete (window as unknown as { queryLocalFonts?: unknown }).queryLocalFonts
    mountProvider()
    const font = currentApi as FontApi
    const phase = await font.check("sans")
    expect(phase).toBe("unsupported")
    expect(font.phase("sans")).toBe("unsupported")
  })

  test("denied phase when the font permission is rejected", async () => {
    window.queryLocalFonts = async () => {
      throw new DOMException("denied", "NotAllowedError")
    }
    mountProvider()
    const font = currentApi as FontApi
    const phase = await font.check("sans")
    expect(phase).toBe("denied")
    expect(font.phase("sans")).toBe("denied")
  })

  test("applying a custom font resets font-feature-settings for third-party families", async () => {
    setLocalFonts([{ family: "Custom Font", fullName: "Custom Font" }])
    mountProvider()
    const font = currentApi as FontApi
    await font.check("sans")
    font.select("sans", "Custom Font")
    font.apply("sans")

    const root = document.documentElement
    expect(root.style.getPropertyValue("--font-family-sans")).toContain('"Custom Font"')
    expect(root.style.getPropertyValue("--font-family-sans--font-feature-settings")).toBe("normal")

    font.reset("sans")
    expect(root.style.getPropertyValue("--font-family-sans")).toBe("")
    expect(root.style.getPropertyValue("--font-family-sans--font-feature-settings")).toBe("")
  })

  test("a new provider instance restores the persisted applied font", async () => {
    setLocalFonts([{ family: "Arial", fullName: "Arial" }])
    mountProvider()
    const first = currentApi as FontApi
    await first.check("sans")
    first.select("sans", "Arial")
    first.apply("sans")
    expect(first.appliedFamily("sans")).toBe("Arial")

    // A second provider instance starts from the persisted preference: the
    // applied family is restored (and pre-selected) without any action.
    currentApi = undefined
    mountProvider()
    const second = currentApi as FontApi
    expect(second.appliedFamily("sans")).toBe("Arial")
    expect(second.selected("sans")).toBe("Arial")
    expect(second.phase("sans")).toBe("idle")
  })
})
