import { expect, test } from "bun:test"
import { compilePluginManifest, definePlugin, settings } from "@ericsanchezok/synergy-plugin"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import {
  getPluginConfig,
  replacePluginConfig,
  setPluginConfigKey,
  matchesPluginSettingCondition,
} from "../../src/plugin/config-store"

test("plugin settings apply cloned defaults and declared keys, reject invalid writes, and retain other plugins", async () => {
  const domain = await Config.domainGet("plugins")
  const id = `settings-${crypto.randomUUID()}`
  const manifest = compilePluginManifest(
    definePlugin({
      id,
      version: "1.0.0",
      description: "Settings fixture",
      contributions: [
        settings({
          id: "settings",
          label: "Settings",
          group: "Plugins",
          formSchema: {
            type: "object",
            properties: {
              enabled: { type: "boolean", default: false },
              labels: { type: "array", items: { type: "string" }, default: [] },
            },
            additionalProperties: false,
          },
        }),
      ],
    }),
    { generation: "fixture" },
  )
  try {
    await Config.domainUpdate(
      "plugins",
      { ...domain, pluginConfig: { [id]: { retired: "hidden" }, untouched: { value: "kept" } } },
      { mode: "replace-domain" },
    )
    const first = await getPluginConfig(id, { manifest })
    expect(first).toEqual({ enabled: false, labels: [] })
    ;(first.labels as string[]).push("mutated")
    expect(await getPluginConfig(id, { manifest })).toEqual({ enabled: false, labels: [] })
    await expect(replacePluginConfig(id, [], { manifest })).rejects.toThrow("config must be an object")
    await expect(replacePluginConfig(id, { enabled: "yes" }, { manifest })).rejects.toMatchObject({
      name: "PluginConfigValidationError",
    })
    expect(await setPluginConfigKey(id, "enabled", true, { manifest })).toEqual({ enabled: true, labels: [] })
    expect((await Config.domainGet("plugins")).pluginConfig?.untouched).toEqual({ value: "kept" })
    expect(
      matchesPluginSettingCondition({ setting: "enabled", equals: true }, await getPluginConfig(id, { manifest })),
    ).toBe(true)
    expect(
      matchesPluginSettingCondition({ setting: "enabled", equals: false }, await getPluginConfig(id, { manifest })),
    ).toBe(false)
  } finally {
    await Config.domainUpdate("plugins", domain, { mode: "replace-domain" })
  }
})
