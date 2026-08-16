import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ThemePicker } from "../../../../src/components/settings/components/ThemePicker"

const source = readFileSync(
  join(import.meta.dir, "../../../../src/components/settings/components/ThemePicker.tsx"),
  "utf8",
)

describe("ThemePicker module contract", () => {
  test("exports a Solid component", () => {
    expect(typeof ThemePicker).toBe("function")
  })

  test("renders a radiogroup of theme cards with per-card preview tokens", () => {
    expect(source).toContain('role="radiogroup"')
    expect(source).toContain('role="radio"')
    expect(source).toContain("settings-theme-card")
    expect(source).toContain("settings-theme-preview")
    expect(source).toContain("aria-checked")
  })

  test("resolves each card's preview tokens once per mode", () => {
    expect(source).toMatch(/createMemo\(\(\) => resolveTheme\(choice\.theme\)\[props\.mode\]\)/)
  })

  test("reports the selected theme id through onChange", () => {
    expect(source).toMatch(/onClick=\{\(\) => props\.onChange\(choice\.id\)\}/)
  })
})
