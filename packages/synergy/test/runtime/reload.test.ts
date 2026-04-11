import { afterEach, describe, expect, mock, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/scope/instance"
import { RuntimeReload } from "../../src/runtime/reload"
import { Config } from "../../src/config/config"
import { ConfigSet } from "../../src/config/set"
import { GlobalBus } from "../../src/bus/global"

const originalConfigReload = Config.reload

afterEach(() => {
  Config.reload = originalConfigReload
  GlobalBus.removeAllListeners("event")
})

describe("runtime.reload", () => {
  test("detects config, skill, and custom tool targets by file path", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await Bun.write(path.join(tmp.path, ".synergy", "skill", "demo", "SKILL.md"), "---\nname: demo\n---\n")
        const configTarget = RuntimeReload.detectTargetsForFile(path.join(tmp.path, ".synergy", "synergy.jsonc"))
        const skillTarget = RuntimeReload.detectTargetsForFile(
          path.join(tmp.path, ".synergy", "skill", "demo", "SKILL.md"),
        )
        const toolTarget = RuntimeReload.detectTargetsForFile(path.join(tmp.path, ".synergy", "tool", "demo.ts"))

        expect(configTarget).toEqual(["config"])
        expect(skillTarget).toEqual(["skill"])
        expect(toolTarget).toEqual(["tool_registry"])
      },
    })
  })

  test("detects skill targets across shared runtime skill roots", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalHome = process.env.SYNERGY_TEST_HOME
    process.env.SYNERGY_TEST_HOME = tmp.path

    try {
      await Bun.write(
        path.join(tmp.path, ".synergy", "skill", "global-demo", "SKILL.md"),
        "---\nname: global-demo\ndescription: demo\n---\n",
      )
      await Bun.write(
        path.join(tmp.path, ".claude", "skills", "compat-demo", "SKILL.md"),
        "---\nname: compat-demo\ndescription: demo\n---\n",
      )

      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const globalSkillTarget = RuntimeReload.detectTargetsForFile(
            path.join(tmp.path, ".synergy", "skill", "global-demo", "SKILL.md"),
          )
          const compatSkillTarget = RuntimeReload.detectTargetsForFile(
            path.join(tmp.path, ".claude", "skills", "compat-demo", "SKILL.md"),
          )

          expect(globalSkillTarget).toEqual(["skill"])
          expect(compatSkillTarget).toEqual(["skill"])
        },
      })
    } finally {
      process.env.SYNERGY_TEST_HOME = originalHome
    }
  })

  test("returns live-applied and restart-required config fields", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "synergy.jsonc"),
          JSON.stringify({
            $schema: "file:///test/config.schema.json",
            model: "openai/gpt-4.1",
          }),
        )
      },
    })

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await RuntimeReload.reload({ targets: ["config"], scope: "project", reason: "prime" })
        await Bun.write(
          path.join(tmp.path, "synergy.jsonc"),
          JSON.stringify({
            $schema: "file:///test/config.schema.json",
            model: "openai/gpt-5",
            server: { port: 4123 },
          }),
        )

        const result = await RuntimeReload.reload({ targets: ["config"], scope: "project", reason: "test" })
        expect(result.changedFields).toContain("model")
        expect(result.changedFields).toContain("server")
        expect(result.liveApplied).toContain("model")
        expect(result.restartRequired).toContain("server")
      },
    })
  })

  test("all expands into concrete targets", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const result = await RuntimeReload.reload({ targets: ["all"], scope: "global", reason: "test" })
        expect(result.requested).toEqual(["all"])
        expect(result.executed).toContain("config")
        expect(result.executed).toContain("skill")
        expect(result.executed).toContain("tool_registry")
        expect(result.warnings.some((item) => item.includes("packages/synergy/src"))).toBe(true)
      },
    })
  })

  test("warns when editing built-in source paths", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const warning = RuntimeReload.builtinSourceEditWarning(
          path.join(tmp.path, "packages", "synergy", "src", "tool", "agora-read.ts"),
        )
        expect(warning).toContain("restarting the backend process")
      },
    })
  })

  test("reload auto scope prefers project config when present and emits runtime event", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "synergy.jsonc"), JSON.stringify({ model: "openai/gpt-4.1" }))
      },
    })

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const configReloadMock = mock(async (scope: "global" | "project") => ({
          config: {},
          changedFields: scope === "project" ? ["model"] : [],
        }))
        Config.reload = configReloadMock as typeof Config.reload

        const eventPromise = new Promise<{ directory?: string; payload: any }>((resolve) => {
          GlobalBus.once("event", resolve)
        })

        const result = await RuntimeReload.reload({ targets: ["config"], reason: "auto-scope" })
        const event = await eventPromise

        expect(configReloadMock).toHaveBeenCalledWith("project")
        expect(result.executed).toEqual(["config", "agent"])
        expect(result.changedFields).toEqual(["model"])
        expect(event.payload.type).toBe(RuntimeReload.Event.Reloaded.type)
        expect(event.payload.properties.executed).toEqual(["config", "agent"])
        expect(event.payload.properties.cascaded).toEqual(["agent"])
      },
    })
  })

  test("detects active config set file as global scope and ignores inactive custom sets", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await ConfigSet.create("test-set")
        await ConfigSet.create("other-set")
        await ConfigSet.activate("test-set")

        expect(RuntimeReload.detectScopeForFile(ConfigSet.filePath("test-set"))).toBe("global")
        expect(RuntimeReload.detectScopeForFile(ConfigSet.filePath("other-set"))).toBeUndefined()
      },
    })
  })

  test("config reload reports cascaded targets and warnings from changed fields", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const configReloadMock = mock(async () => ({
          config: {},
          changedFields: ["provider", "plugin", "mcp", "watcher", "channel", "server", "theme"],
        }))
        Config.reload = configReloadMock as typeof Config.reload

        const result = await RuntimeReload.reload({ targets: ["config"], scope: "global", reason: "cascade" })

        expect(result.executed).toEqual([
          "config",
          "provider",
          "agent",
          "plugin",
          "tool_registry",
          "mcp",
          "command",
          "watcher",
          "channel",
        ])
        expect(result.cascaded).toEqual([
          "provider",
          "agent",
          "plugin",
          "tool_registry",
          "mcp",
          "command",
          "watcher",
          "channel",
        ])
        expect(result.restartRequired).toContain("server")
        expect(result.warnings).toContain(
          "Config field `theme` is client-side and is not reloaded by the server runtime",
        )
      },
    })
  })
})
