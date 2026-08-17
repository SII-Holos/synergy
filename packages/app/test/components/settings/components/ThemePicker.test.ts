import { describe, expect, test } from "bun:test"
import { ThemePicker } from "../../../../src/components/settings/components/ThemePicker"

// Module-load smoke: importing the component registers it in the coverage
// lcov shard. Real DOM/interaction behavior is covered by the Playwright
// fixture in ThemePicker.behavior.test.tsx; bun's test transform compiles
// TSX JSX to React.createElement, so it cannot render Solid components.
describe("ThemePicker module", () => {
  test("exports a Solid component", () => {
    expect(typeof ThemePicker).toBe("function")
  })
})
