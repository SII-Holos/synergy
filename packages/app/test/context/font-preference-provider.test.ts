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

const { FontPreferenceProvider, findLocalFontFamily, useFontPreference } = await import(
  "../../src/context/font-preference"
)

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

describe("font preference provider behavior (PR #1055 fixes)", () => {
  test("typing does not dispatch font-change events and keeps the applied font", async () => {
    let events = 0
    document.addEventListener("synergy:font-change", () => events++)
    setLocalFonts([{ family: "A", fullName: "A" }])
    mountProvider()
    const font = currentApi as FontApi
    font.setFamily("sans", "A")
    await font.checkAndApply("sans")
    expect(font.status("sans")).toBe("applied")

    const before = events
    font.setFamily("sans", "AB")
    font.setFamily("sans", "ABC")
    font.setFamily("sans", "ABCD")

    // Draft typing is local: no broadcast, no storage churn, applied font intact.
    expect(events - before).toBe(0)
    expect(font.appliedFamily("sans")).toBe("A")
    expect(font.status("sans")).toBe("editing")
  })

  test("a stale checkAndApply no longer overwrites the newer requested family", async () => {
    let resolveFonts!: (fonts: { family: string; fullName: string }[]) => void
    window.queryLocalFonts = () =>
      new Promise((resolve) => {
        resolveFonts = resolve
      })
    mountProvider()
    const font = currentApi as FontApi
    font.setFamily("sans", "A")
    const pending = font.checkAndApply("sans")
    font.setFamily("sans", "B") // newer input while check is in flight
    expect(font.family("sans")).toBe("B")

    resolveFonts([{ family: "A", fullName: "A" }])
    await pending

    // The stale result must not clobber the draft or apply the abandoned font.
    expect(font.family("sans")).toBe("B")
    expect(font.appliedFamily("sans")).toBe("")
    expect(font.status("sans")).toBe("editing")
  })

  test("reset during an in-flight check stays reset", async () => {
    let resolveFonts!: (fonts: { family: string; fullName: string }[]) => void
    window.queryLocalFonts = () =>
      new Promise((resolve) => {
        resolveFonts = resolve
      })
    mountProvider()
    const font = currentApi as FontApi
    font.setFamily("sans", "A")
    const pending = font.checkAndApply("sans")
    font.reset("sans")
    expect(font.family("sans")).toBe("")

    resolveFonts([{ family: "A", fullName: "A" }])
    await pending

    expect(font.family("sans")).toBe("")
    expect(font.appliedFamily("sans")).toBe("")
    expect(font.status("sans")).toBe("default")
  })

  test("checkAndApply with empty input resets to default", async () => {
    setLocalFonts([{ family: "A", fullName: "A" }])
    mountProvider()
    const font = currentApi as FontApi
    font.setFamily("sans", "A")
    await font.checkAndApply("sans")
    expect(font.status("sans")).toBe("applied")

    font.setFamily("sans", "")
    const result = await font.checkAndApply("sans")
    expect(result).toBe("default")
    expect(font.status("sans")).toBe("default")
    expect(font.appliedFamily("sans")).toBe("")
  })

  test("missing font keeps the previously applied font", async () => {
    setLocalFonts([{ family: "A", fullName: "A" }])
    mountProvider()
    const font = currentApi as FontApi
    font.setFamily("sans", "A")
    await font.checkAndApply("sans")
    expect(font.appliedFamily("sans")).toBe("A")

    font.setFamily("sans", "Missing Font")
    const result = await font.checkAndApply("sans")
    expect(result).toBe("missing")
    // Previously applied font stays active.
    expect(font.appliedFamily("sans")).toBe("A")
    expect(font.status("sans")).toBe("missing")
  })

  test("localized fullName with a CJK style suffix matches after fix", async () => {
    setLocalFonts([{ family: "LXGW WenKai", fullName: "霞鹜文楷 常规" }])
    await expect(findLocalFontFamily("霞鹜文楷")).resolves.toBe("found")
  })

  test("localized fullName with an English style suffix still matches", async () => {
    setLocalFonts([{ family: "LXGW WenKai", fullName: "霞鹜文楷 Regular" }])
    await expect(findLocalFontFamily("霞鹜文楷")).resolves.toBe("found")
  })

  test("applying a custom font resets font-feature-settings for third-party families", async () => {
    setLocalFonts([{ family: "Custom Font", fullName: "Custom Font" }])
    mountProvider()
    const font = currentApi as FontApi
    font.setFamily("sans", "Custom Font")
    await font.checkAndApply("sans")

    const root = document.documentElement
    expect(root.style.getPropertyValue("--font-family-sans")).toContain('"Custom Font"')
    expect(root.style.getPropertyValue("--font-family-sans--font-feature-settings")).toBe("normal")

    font.reset("sans")
    expect(root.style.getPropertyValue("--font-family-sans")).toBe("")
    expect(root.style.getPropertyValue("--font-family-sans--font-feature-settings")).toBe("")
  })
})
