import { expect, test } from "bun:test"
import { pluginPreviewChanged } from "../../src/plugin/preview"

test("preview refreshes validated replacements, never initial mounts or unchanged reconnects", () => {
  const first = [{ pluginId: "plugin", generation: "first" }]
  const second = [{ pluginId: "plugin", generation: "second" }]
  expect(pluginPreviewChanged([], first)).toBe(false)
  expect(pluginPreviewChanged(first, first)).toBe(false)
  expect(pluginPreviewChanged(first, second)).toBe(true)
  expect(pluginPreviewChanged(first, [])).toBe(false)
})
