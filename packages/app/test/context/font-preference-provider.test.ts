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

describe("font preference provider staged save model", () => {
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
    expect(await font.check("sans")).toBe("ready")
    expect(font.phase("sans")).toBe("ready")
    expect(font.fontList("sans")).toEqual(["Arial", "LXGW WenKai", "Zapf Dingbats"])
  })

  test("selection is staged until save applies and persists it", async () => {
    let events = 0
    document.addEventListener("synergy:font-change", () => events++)
    setLocalFonts([{ family: "Arial", fullName: "Arial" }])
    mountProvider()
    const font = currentApi as FontApi
    await font.check("sans")

    font.select("sans", "Arial")
    expect(font.dirty("sans")).toBe(true)
    expect(font.appliedFamily("sans")).toBe("")
    expect(document.documentElement.style.getPropertyValue("--font-family-sans")).toBe("")
    expect(events).toBe(0)

    expect(font.save()).toBe(true)
    expect(font.dirty("sans")).toBe(false)
    expect(font.appliedFamily("sans")).toBe("Arial")
    expect(document.documentElement.style.getPropertyValue("--font-family-sans")).toContain('"Arial"')
    expect(events).toBe(1)
  })

  test("save rejects a non-empty selection before fonts are checked", () => {
    mountProvider()
    const font = currentApi as FontApi

    font.select("sans", "Arial")
    expect(font.save()).toBe(false)
    expect(font.dirty("sans")).toBe(true)
    expect(font.appliedFamily("sans")).toBe("")
  })

  test("discard restores the applied selection without changing CSS", async () => {
    setLocalFonts([{ family: "Arial", fullName: "Arial" }])
    mountProvider()
    const font = currentApi as FontApi
    await font.check("sans")

    font.select("sans", "Arial")
    font.discard()

    expect(font.selected("sans")).toBe("")
    expect(font.dirty()).toBe(false)
    expect(document.documentElement.style.getPropertyValue("--font-family-sans")).toBe("")
  })

  test("reset stages the default font until save", async () => {
    setLocalFonts([{ family: "Arial", fullName: "Arial" }])
    mountProvider()
    const font = currentApi as FontApi
    await font.check("sans")
    font.select("sans", "Arial")
    font.save()

    font.reset("sans")
    expect(font.appliedFamily("sans")).toBe("Arial")
    expect(font.selected("sans")).toBe("")
    expect(font.dirty("sans")).toBe(true)
    expect(document.documentElement.style.getPropertyValue("--font-family-sans")).toContain('"Arial"')

    expect(font.save()).toBe(true)
    expect(font.appliedFamily("sans")).toBe("")
    expect(font.dirty("sans")).toBe(false)
    expect(document.documentElement.style.getPropertyValue("--font-family-sans")).toBe("")
  })

  test("a stale check result does not clobber a staged reset", async () => {
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
    expect(await pending).toBe("idle")
    expect(font.phase("sans")).toBe("idle")
    expect(font.fontList("sans")).toEqual([])
  })

  test("already applied family is pre-selected and kept in the list", async () => {
    setLocalFonts([{ family: "Arial", fullName: "Arial" }])
    mountProvider()
    const font = currentApi as FontApi
    await font.check("sans")
    font.select("sans", "Arial")
    font.save()

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
    expect(await font.check("sans")).toBe("unsupported")
    expect(font.phase("sans")).toBe("unsupported")
  })

  test("denied phase when the font permission is rejected", async () => {
    window.queryLocalFonts = async () => {
      throw new DOMException("denied", "NotAllowedError")
    }
    mountProvider()
    const font = currentApi as FontApi
    expect(await font.check("sans")).toBe("denied")
    expect(font.phase("sans")).toBe("denied")
  })

  test("saving a custom font resets feature settings for third-party families", async () => {
    setLocalFonts([{ family: "Custom Font", fullName: "Custom Font" }])
    mountProvider()
    const font = currentApi as FontApi
    await font.check("sans")
    font.select("sans", "Custom Font")
    font.save()

    const root = document.documentElement
    expect(root.style.getPropertyValue("--font-family-sans")).toContain('"Custom Font"')
    expect(root.style.getPropertyValue("--font-family-sans--font-feature-settings")).toBe("normal")

    font.reset("sans")
    expect(root.style.getPropertyValue("--font-family-sans")).toContain('"Custom Font"')
    font.save()
    expect(root.style.getPropertyValue("--font-family-sans")).toBe("")
    expect(root.style.getPropertyValue("--font-family-sans--font-feature-settings")).toBe("")
  })

  test("a new provider instance restores the persisted applied font", async () => {
    setLocalFonts([{ family: "Arial", fullName: "Arial" }])
    mountProvider()
    const first = currentApi as FontApi
    await first.check("sans")
    first.select("sans", "Arial")
    first.save()
    expect(first.appliedFamily("sans")).toBe("Arial")

    currentApi = undefined
    mountProvider()
    const second = currentApi as FontApi
    expect(second.appliedFamily("sans")).toBe("Arial")
    expect(second.selected("sans")).toBe("Arial")
    expect(second.phase("sans")).toBe("idle")
  })
})
