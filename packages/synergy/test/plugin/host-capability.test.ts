import { describe, expect, test } from "bun:test"
import path from "path"
import { capability, compilePluginManifest, definePlugin } from "@ericsanchezok/synergy-plugin"
import { assertPluginManifestCapability } from "../../src/plugin/host-services"
import { tmpdir } from "../fixture/fixture"

describe("plugin Host Service capability boundary", () => {
  test("keeps task.delegate capability separate from the runtime task permission", async () => {
    await using tmp = await tmpdir()
    const definition = definePlugin({
      id: "task-capability-test",
      version: "1.0.0",
      description: "Host capability boundary test",
      capabilities: [capability("task.delegate")],
      contributions: [],
    })
    const manifest = compilePluginManifest(definition, { generation: "generation-one" })
    await Bun.write(path.join(tmp.path, "plugin.json"), JSON.stringify(manifest))

    await expect(
      assertPluginManifestCapability({
        pluginDir: tmp.path,
        capability: "task.delegate",
      }),
    ).resolves.toBeUndefined()
    await expect(
      assertPluginManifestCapability({
        pluginDir: tmp.path,
        capability: "task",
      }),
    ).rejects.toThrow('does not allow capability "task"')
  })
})
