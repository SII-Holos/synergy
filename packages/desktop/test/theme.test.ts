import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  desktopThemeBackground,
  desktopThemeFilePath,
  DesktopThemeSource,
  loadDesktopThemeSource,
  parseDesktopThemeSource,
  resolveDesktopThemeEffective,
  saveDesktopThemeSource,
} from "../src/theme.js"

async function withTempUserData<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synergy-desktop-theme-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("desktop theme", () => {
  test("loads system when desktop-theme.json is missing or invalid", async () => {
    await withTempUserData(async (dir) => {
      expect(await loadDesktopThemeSource(dir)).toBe("system")

      await writeFile(desktopThemeFilePath(dir), "not json", "utf8")
      expect(await loadDesktopThemeSource(dir)).toBe("system")

      await writeFile(desktopThemeFilePath(dir), JSON.stringify({ source: "blue" }), "utf8")
      expect(await loadDesktopThemeSource(dir)).toBe("system")
    })
  })

  test("persists and reloads light dark system source", async () => {
    await withTempUserData(async (dir) => {
      for (const source of ["light", "dark", "system"] as const) {
        await saveDesktopThemeSource(dir, source)
        expect(await loadDesktopThemeSource(dir)).toBe(source)
      }
    })
  })

  test("resolves system from shouldUseDarkColors", () => {
    expect(resolveDesktopThemeEffective("system", false)).toBe("light")
    expect(resolveDesktopThemeEffective("system", true)).toBe("dark")
    expect(resolveDesktopThemeEffective("light", true)).toBe("light")
    expect(resolveDesktopThemeEffective("dark", false)).toBe("dark")
  })

  test("maps effective light and dark to Synergy background colors", () => {
    expect(desktopThemeBackground("light")).toBe("#FAFAFA")
    expect(desktopThemeBackground("dark")).toBe("#0F0F10")
  })

  test("rejects unknown desktop theme source", () => {
    expect(parseDesktopThemeSource("light")).toBe("light")
    expect(() => parseDesktopThemeSource("blue")).toThrow()
    expect(DesktopThemeSource.safeParse("system").success).toBe(true)
    expect(DesktopThemeSource.safeParse("blue").success).toBe(false)
  })
})
