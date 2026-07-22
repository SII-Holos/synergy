import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  defaultDesktopSkinState,
  desktopThemeBackground,
  desktopThemeFilePath,
  desktopThemeSnapshot,
  DesktopThemeSource,
  loadDesktopSkinState,
  parseDesktopSkinUpdate,
  parseDesktopThemeSource,
  resolveDesktopThemeEffective,
  saveDesktopSkinState,
} from "../src/theme.js"

async function withTempUserData<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synergy-desktop-theme-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("desktop skin", () => {
  test("falls back to the generated Synergy skin when state is missing or invalid", async () => {
    await withTempUserData(async (dir) => {
      expect(await loadDesktopSkinState(dir)).toEqual(defaultDesktopSkinState())
      await writeFile(desktopThemeFilePath(dir), "not json", "utf8")
      expect(await loadDesktopSkinState(dir)).toEqual(defaultDesktopSkinState())
      await writeFile(desktopThemeFilePath(dir), JSON.stringify({ version: 2, source: "blue" }), "utf8")
      expect(await loadDesktopSkinState(dir)).toEqual(defaultDesktopSkinState())
    })
  })

  test("migrates the legacy source-only file to V2 with generated fallback colors", async () => {
    await withTempUserData(async (dir) => {
      await writeFile(desktopThemeFilePath(dir), JSON.stringify({ source: "dark" }), "utf8")
      const state = await loadDesktopSkinState(dir)
      expect(state).toEqual(defaultDesktopSkinState("dark"))
      expect(JSON.parse(await Bun.file(desktopThemeFilePath(dir)).text())).toEqual(state)
    })
  })

  test("persists and reloads a validated custom two-variant skin", async () => {
    await withTempUserData(async (dir) => {
      const state = defaultDesktopSkinState("system")
      state.themeId = "acme:violet"
      state.light.background = "#123456"
      state.dark.background = "#654321"
      await saveDesktopSkinState(dir, state)
      expect(await loadDesktopSkinState(dir)).toEqual(state)
    })
  })

  test("switches only the active variant when system appearance changes", () => {
    const state = defaultDesktopSkinState("system")
    state.themeId = "acme:violet"
    state.light.background = "#123456"
    state.dark.background = "#654321"
    const light = desktopThemeSnapshot(state, false)
    const dark = desktopThemeSnapshot(state, true)
    expect(light.effective).toBe("light")
    expect(dark.effective).toBe("dark")
    expect(desktopThemeBackground(light)).toBe("#123456")
    expect(desktopThemeBackground(dark)).toBe("#654321")
    expect(dark.themeId).toBe("acme:violet")
  })

  test("strictly rejects malformed full-skin IPC input", () => {
    const state = defaultDesktopSkinState()
    const valid = { source: state.source, themeId: state.themeId, light: state.light, dark: state.dark }
    expect(parseDesktopSkinUpdate(valid)).toEqual(valid)
    expect(() => parseDesktopSkinUpdate({ ...valid, light: { ...state.light, background: "red" } })).toThrow()
    expect(() => parseDesktopSkinUpdate({ ...valid, unknown: true })).toThrow()
  })

  test("resolves source and rejects unknown values", () => {
    expect(resolveDesktopThemeEffective("system", false)).toBe("light")
    expect(resolveDesktopThemeEffective("system", true)).toBe("dark")
    expect(resolveDesktopThemeEffective("light", true)).toBe("light")
    expect(resolveDesktopThemeEffective("dark", false)).toBe("dark")
    expect(parseDesktopThemeSource("light")).toBe("light")
    expect(() => parseDesktopThemeSource("blue")).toThrow()
    expect(DesktopThemeSource.safeParse("system").success).toBe(true)
    expect(DesktopThemeSource.safeParse("blue").success).toBe(false)
  })
})
