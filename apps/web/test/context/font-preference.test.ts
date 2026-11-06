import { describe, expect, test } from "bun:test"
import {
  fontFamilyValue,
  isValidFontFamily,
  loadLocalFontFamilies,
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

  test("loads, deduplicates, and sorts local font families", async () => {
    const original = window.queryLocalFonts
    window.queryLocalFonts = async () => [
      { family: "Zapf Dingbats", fullName: "Zapf Dingbats" },
      { family: "  LXGW   WenKai  ", fullName: "霞鹜文楷 Regular" },
      { family: "Arial", fullName: "Arial" },
      { family: "Arial", fullName: "Arial Bold" },
      { family: "", fullName: "" },
    ]
    try {
      await expect(loadLocalFontFamilies()).resolves.toEqual({
        status: "ok",
        families: ["Arial", "LXGW WenKai", "Zapf Dingbats"],
      })
    } finally {
      window.queryLocalFonts = original
    }
  })

  test("reports unsupported when queryLocalFonts is unavailable", async () => {
    const original = window.queryLocalFonts
    delete (window as unknown as { queryLocalFonts?: unknown }).queryLocalFonts
    try {
      await expect(loadLocalFontFamilies()).resolves.toEqual({ status: "unsupported" })
    } finally {
      window.queryLocalFonts = original
    }
  })

  test("reports denied when the font permission is rejected", async () => {
    const original = window.queryLocalFonts
    window.queryLocalFonts = async () => {
      throw new DOMException("denied", "NotAllowedError")
    }
    try {
      await expect(loadLocalFontFamilies()).resolves.toEqual({ status: "denied" })
    } finally {
      window.queryLocalFonts = original
    }
  })
})
