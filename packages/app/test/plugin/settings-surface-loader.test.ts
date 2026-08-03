import { describe, expect, test } from "bun:test"
import type { Component } from "solid-js"
import type { PluginSettingsComponentProps } from "@ericsanchezok/synergy-plugin"
import { createPluginSettingsSurfaceLoader } from "../../src/plugin/settings-surface-loader"

describe("plugin Settings surface loader", () => {
  test("returns the trusted component unchanged so the Settings host can pass context and legacy props", async () => {
    const SettingsComponent: Component<PluginSettingsComponentProps> = () => null
    const calls: unknown[][] = []
    const loader = createPluginSettingsSurfaceLoader(
      {
        pluginId: "example",
        assetUrl: "http://127.0.0.1/plugin/example/settings.js",
        exportName: "Settings",
      },
      async (...args: unknown[]) => {
        calls.push(args)
        return { default: SettingsComponent }
      },
    )

    const loaded = await loader()

    expect(loaded.default).toBe(SettingsComponent)
    expect(calls).toEqual([["example", "http://127.0.0.1/plugin/example/settings.js", "Settings", "4.0"]])
  })
})
