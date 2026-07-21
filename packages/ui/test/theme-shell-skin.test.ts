import { describe, expect, test } from "bun:test"
import { synergyTheme } from "../src/theme/default-themes"
import {
  SKIN_BOOTSTRAP_STORAGE_KEY,
  createSkinBootstrapSnapshot,
  deriveShellSkin,
  readSkinBootstrapSnapshot,
  writeSkinBootstrapSnapshot,
} from "../src/theme/shell-skin"

function storage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    values,
  }
}

describe("skin bootstrap snapshot", () => {
  test("derives complete flattened shell colors for both modes", () => {
    const shell = deriveShellSkin(synergyTheme)
    expect(Object.keys(shell.light)).toEqual(Object.keys(shell.dark))
    for (const value of [...Object.values(shell.light), ...Object.values(shell.dark)]) {
      expect(value).toMatch(/^#[0-9a-f]{6,8}$/i)
    }
  })

  test("revalidates the theme and derives shell colors instead of trusting cached shell input", () => {
    const target = storage()
    const snapshot = createSkinBootstrapSnapshot("ocean:default", { ...synergyTheme, id: "default" })
    writeSkinBootstrapSnapshot(snapshot, target)
    const cached = JSON.parse(target.values.get(SKIN_BOOTSTRAP_STORAGE_KEY)!)
    cached.shell.light.background = "#ff00ff"
    target.values.set(SKIN_BOOTSTRAP_STORAGE_KEY, JSON.stringify(cached))

    expect(readSkinBootstrapSnapshot(target)?.shell.light.background).toBe(snapshot.shell.light.background)
  })

  test("fails closed for malformed or resolver-invalid cache entries", () => {
    const target = storage()
    target.values.set(SKIN_BOOTSTRAP_STORAGE_KEY, "not json")
    expect(readSkinBootstrapSnapshot(target)).toBeNull()

    const snapshot = createSkinBootstrapSnapshot("synergy", synergyTheme)
    const invalid = {
      ...snapshot,
      theme: {
        ...snapshot.theme,
        dark: { ...snapshot.theme.dark, overrides: { "border-base": "var(--border-base)" } },
      },
    }
    target.values.set(SKIN_BOOTSTRAP_STORAGE_KEY, JSON.stringify(invalid))
    expect(readSkinBootstrapSnapshot(target)).toBeNull()
  })
})
