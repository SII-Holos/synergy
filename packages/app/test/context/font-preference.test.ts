import { describe, expect, test } from "bun:test"
import {
  findLocalFontFamily,
  fontFamilyValue,
  isValidFontFamily,
  migrateFontPreferences,
  normalizeFontFamily,
} from "../../src/context/font-preference"

describe("font preference helpers", () => {
  test("normalizes a user-entered family without changing its name", () => {
    expect(normalizeFontFamily("  LXGW   WenKai  ")).toBe("LXGW WenKai")
    expect(fontFamilyValue("LXGW WenKai")).toContain('"LXGW WenKai"')
    expect(fontFamilyValue("Cascadia Mono", "mono")).toContain('"IBM Plex Mono", "IBM Plex Mono Fallback"')
  })

  test("keeps the existing interface preference when adding the monospace preference", () => {
    expect(migrateFontPreferences({ requestedFamily: "霞鹜文楷", appliedFamily: "霞鹜文楷" })).toEqual({
      sans: { requestedFamily: "霞鹜文楷", appliedFamily: "霞鹜文楷" },
      mono: { requestedFamily: "", appliedFamily: "" },
    })
  })

  test("rejects CSS list and declaration syntax", () => {
    expect(isValidFontFamily("LXGW WenKai")).toBe(true)
    expect(isValidFontFamily("Inter, sans-serif")).toBe(false)
    expect(isValidFontFamily("Inter; color: red")).toBe(false)
  })

  test("uses the local font API when it is available", async () => {
    const original = window.queryLocalFonts
    window.queryLocalFonts = async () => [{ family: "LXGW WenKai", fullName: "霞鹜文楷 Regular" }]
    try {
      await expect(findLocalFontFamily("霞鹜文楷")).resolves.toBe("found")
      await expect(findLocalFontFamily("lxgw wenkai")).resolves.toBe("found")
      await expect(findLocalFontFamily("Missing Font")).resolves.toBe("missing")
    } finally {
      window.queryLocalFonts = original
    }
  })
})
