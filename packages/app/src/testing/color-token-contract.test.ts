import { describe, expect, test } from "bun:test"
import { THEME_TOKEN_SET } from "@ericsanchezok/synergy-ui/theme"

const SOURCE_ROOTS = ["src", "../ui/src"]
const COLOR_CLASS =
  /\b(?:bg|text|border|ring|fill|stroke)-((?:background|surface|text|border|icon|button|input|syntax|markdown|avatar|chart)(?:-[a-z0-9-]+)?)(?:\/[0-9.]+)?\b/g
const LEGACY_PALETTE_CLASS =
  /(?<![a-z0-9-])(?:bg|text|border|ring|fill|stroke)-(?:black|white|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)(?:-[0-9]+)?(?:\/[0-9.]+)?\b/g
const ARBITRARY_COLOR_CLASS = /(?<![a-z0-9-])(?:bg|text|border|ring|fill|stroke)-\[(?:#|rgba?\()/g

describe("frontend color token contract", () => {
  test("semantic color utilities resolve through the canonical theme", async () => {
    const invalid = new Set<string>()
    const glob = new Bun.Glob("**/*.{css,ts,tsx}")

    for (const root of SOURCE_ROOTS) {
      for await (const relativePath of glob.scan({ cwd: root })) {
        const path = `${root}/${relativePath}`
        const source = await Bun.file(path).text()
        for (const match of source.matchAll(COLOR_CLASS)) {
          const token = match[1]
          if (!THEME_TOKEN_SET.has(token)) invalid.add(`${path}: ${match[0]}`)
        }
      }
    }

    expect([...invalid].sort()).toEqual([])
  })

  test("source files do not bypass the semantic contract with literal color utilities", async () => {
    const invalid: string[] = []
    const glob = new Bun.Glob("**/*.{css,ts,tsx}")

    for (const root of SOURCE_ROOTS) {
      for await (const relativePath of glob.scan({ cwd: root })) {
        const path = `${root}/${relativePath}`
        const source = await Bun.file(path).text()
        for (const match of source.matchAll(LEGACY_PALETTE_CLASS)) invalid.push(`${path}: ${match[0]}`)
        for (const match of source.matchAll(ARBITRARY_COLOR_CLASS)) invalid.push(`${path}: ${match[0]}`)
      }
    }

    expect(invalid.sort()).toEqual([])
  })
})
