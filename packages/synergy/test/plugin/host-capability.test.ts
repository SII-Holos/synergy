import { describe, expect, test } from "bun:test"
import path from "path"
import { capability, compilePluginManifest, definePlugin } from "@ericsanchezok/synergy-plugin"
import { assertPluginManifestCapability, requestPluginPermission } from "../../src/plugin/host-services"
import { riskForCapabilities } from "../../src/plugin/capability"
import { PermissionRules } from "../../src/permission/rules"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
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
  test("applies persistent user permission rules to plugin Host Services", async () => {
    await using tmp = await tmpdir({ git: true, config: { controlProfile: "guarded" } })
    const definition = definePlugin({
      id: "persistent-permission-test",
      version: "1.0.0",
      description: "Persistent permission boundary test",
      capabilities: [capability("task.delegate")],
      contributions: [],
    })
    const manifest = compilePluginManifest(definition, { generation: "generation-one" })
    await Bun.write(path.join(tmp.path, "plugin.json"), JSON.stringify(manifest))
    await PermissionRules.addUserRule({ permission: "protected_op", pattern: "persistent-agent", action: "allow" })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ controlProfile: "guarded" })
        await expect(
          requestPluginPermission(
            {
              pluginDir: tmp.path,
              sessionID: session.id,
              messageID: "msg_persistent_permission",
              agent: "synergy-max",
              directory: tmp.path,
              abort: AbortSignal.timeout(5_000),
            },
            {
              capability: "task.delegate",
              permission: "protected_op",
              patterns: ["persistent-agent"],
            },
          ),
        ).resolves.toBeUndefined()
      },
    })
  })
  test("classifies Blueprint and LightLoop delegation as high risk", () => {
    expect(riskForCapabilities(["blueprint.delegate"])).toBe("high")
    expect(riskForCapabilities(["lightloop.delegate"])).toBe("high")
    expect(riskForCapabilities(["composer.write"])).toBe("high")
    expect(riskForCapabilities(["composer.intercept"])).toBe("high")
    expect(riskForCapabilities(["agent.call"])).toBe("high")
    expect(riskForCapabilities(["composer.read"])).toBe("medium")
    expect(riskForCapabilities(["selection.read"])).toBe("medium")
  })

  test("accepts declared Blueprint and LightLoop capabilities without constraints", async () => {
    await using tmp = await tmpdir()
    const definition = definePlugin({
      id: "loop-capability-test",
      version: "1.0.0",
      description: "Loop capability boundary test",
      capabilities: [capability("blueprint.delegate"), capability("lightloop.delegate")],
      contributions: [],
    })
    const manifest = compilePluginManifest(definition, { generation: "generation-one" })
    await Bun.write(path.join(tmp.path, "plugin.json"), JSON.stringify(manifest))

    await expect(
      assertPluginManifestCapability({ pluginDir: tmp.path, capability: "blueprint.delegate" }),
    ).resolves.toBeUndefined()
    await expect(
      assertPluginManifestCapability({ pluginDir: tmp.path, capability: "lightloop.delegate" }),
    ).resolves.toBeUndefined()
  })
})
