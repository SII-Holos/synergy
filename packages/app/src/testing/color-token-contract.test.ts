import { describe, expect, test } from "bun:test"
import { THEME_TOKEN_SET } from "@ericsanchezok/synergy-ui/theme"

const SOURCE_ROOTS = ["src", "../ui/src"]
const COLOR_CLASS =
  /\b(?:bg|text|border|ring|fill|stroke)-((?:background|surface|text|border|icon|button|input|syntax|markdown|avatar)(?:-[a-z0-9-]+)?)(?:\/[0-9.]+)?\b/g

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
})
