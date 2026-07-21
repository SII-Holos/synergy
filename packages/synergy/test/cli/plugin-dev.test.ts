import { describe, expect, test } from "bun:test"
import { PluginDevCommand } from "../../src/cli/cmd/plugin-dev"
import type { PluginManifest } from "@ericsanchezok/synergy-plugin"

// ---------------------------------------------------------------------------
// yargs builder — verifies no stale sandbox-preview flag
// ---------------------------------------------------------------------------

describe("PluginDevCommand yargs builder", () => {
  test("does not accept --sandbox-preview (removed in V3)", () => {
    const options: Record<string, unknown> = {}

    const fauxYargs = {
      positional(_name: string, _opts: Record<string, unknown>) {
        return this
      },
      option(name: string, opts: Record<string, unknown>) {
        options[name] = opts
        return this
      },
    }

    const builder = (PluginDevCommand as any).builder
    if (typeof builder !== "function") {
      return
    }

    builder(fauxYargs)

    // After builder runs, the flag should NOT be registered
    expect(options["sandbox-preview"]).toBeUndefined()
  })
})
