import { describe, expect, test } from "bun:test"
import type { ToolComponent } from "@ericsanchezok/synergy-ui/tool-registry-lazy"
import {
  getPluginToolRenderer,
  registerPluginToolRenderer,
} from "../../../src/plugin/registries/tool-renderer-registry"

describe("plugin tool renderer registry", () => {
  test("loads one renderer by exact host tool name and unregisters it cleanly", async () => {
    const renderer = (() => null) as unknown as ToolComponent
    let loads = 0
    const unregister = registerPluginToolRenderer("plugin__vibe-lingo__record-correction", async () => {
      loads++
      return { default: renderer }
    })
    try {
      expect(getPluginToolRenderer("plugin__another__tool")).toBeUndefined()
      expect(getPluginToolRenderer("plugin__vibe-lingo__record-correction")).toBeUndefined()
      for (
        let attempt = 0;
        attempt < 20 && getPluginToolRenderer("plugin__vibe-lingo__record-correction") !== renderer;
        attempt++
      ) {
        await Bun.sleep(1)
      }
      expect(loads).toBe(1)
      expect(getPluginToolRenderer("plugin__vibe-lingo__record-correction")).toBe(renderer)
    } finally {
      unregister()
    }
    expect(getPluginToolRenderer("plugin__vibe-lingo__record-correction")).toBeUndefined()
  })
})
