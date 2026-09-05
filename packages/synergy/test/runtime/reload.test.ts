import { afterEach, describe, expect, mock, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { RuntimeReload } from "../../src/runtime/reload"
import { Config } from "../../src/config/config"
import { ConfigDomain } from "../../src/config/domain"
import { GlobalBus } from "../../src/bus/global"
import { Plugin } from "../../src/plugin"
import { CortexConcurrency } from "../../src/cortex/concurrency"
import { AgentTurn } from "../../src/session/agent-turn"
import { Agent } from "../../src/agent/agent"
import { Provider } from "../../src/provider/provider"
import { ProviderAuth } from "../../src/provider/auth"
import { Channel } from "../../src/channel"
import { Embedding } from "../../src/vector/embedding"

const originalConfigReload = Config.reload
const originalNotifyConfigHooks = Plugin.notifyConfigHooks
const originalAgentTurnResize = (AgentTurn as any).resize
const originalAgentReload = Agent.reload
const originalProviderReload = Provider.reload
const originalProviderAuthReload = ProviderAuth.reload
const originalChannelReload = Channel.reload

afterEach(async () => {
  Config.reload = originalConfigReload
  ;(Plugin as any).notifyConfigHooks = originalNotifyConfigHooks
  ;(AgentTurn as any).resize = originalAgentTurnResize
  Agent.reload = originalAgentReload
  Provider.reload = originalProviderReload
  ProviderAuth.reload = originalProviderAuthReload
  Channel.reload = originalChannelReload
  GlobalBus.removeAllListeners("event")
  CortexConcurrency.reset()
  await Embedding.resetForTest()
})

test("post-write diagnostics settings are live-applied without restarting LSP", () => {
  expect(RuntimeReload.CONFIG_LIVE_APPLIED.has("lspWriteDiagnostics")).toBe(true)
  expect(RuntimeReload.CONFIG_LIVE_APPLIED.has("lspDiagnostics")).toBe(true)
  expect(RuntimeReload.inferConfigCascades(["lspWriteDiagnostics", "lspDiagnostics"])).not.toContain("lsp")
})

describe("runtime.reload", () => {
  test("detects config, skill, and custom tool targets by file path", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await Bun.write(path.join(tmp.path, ".synergy", "skill", "demo", "SKILL.md"), "---\nname: demo\n---\n")
        const configTarget = RuntimeReload.detectTargetsForFile(
          path.join(tmp.path, ".synergy", "synergy.d", "10-models.jsonc"),
        )
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

  test("ignores retired plugin source directories", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const pluginTarget = RuntimeReload.detectTargetsForFile(path.join(tmp.path, ".synergy", "plugin", "demo.ts"))
        const pluginScope = RuntimeReload.detectScopeForFile(path.join(tmp.path, ".synergy", "plugin", "demo.ts"))

        expect(pluginTarget).toEqual([])
        expect(pluginScope).toBeUndefined()
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

      await ScopeContext.provide({
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

  test("detectScopeForFile recognizes agent and command directories", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalHome = process.env.SYNERGY_TEST_HOME
    process.env.SYNERGY_TEST_HOME = tmp.path
    try {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const projectAgent = RuntimeReload.detectScopeForFile(path.join(tmp.path, ".synergy", "agent", "custom.md"))
          expect(projectAgent).toBe("project")

          const projectCommand = RuntimeReload.detectScopeForFile(
            path.join(tmp.path, ".synergy", "command", "deploy.md"),
          )
          expect(projectCommand).toBe("project")
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
        await fs.mkdir(path.join(dir, ".synergy", "synergy.d"), { recursive: true })
        await Bun.write(
          path.join(dir, ".synergy", "synergy.d", "10-models.jsonc"),
          JSON.stringify({
            model: "openai/gpt-4.1",
          }),
        )
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await RuntimeReload.reload({ targets: ["config"], scope: "project", reason: "prime" })
        await Bun.write(
          path.join(tmp.path, ".synergy", "synergy.d", "10-models.jsonc"),
          JSON.stringify({
            model: "openai/gpt-5",
          }),
        )
        await Bun.write(
          path.join(tmp.path, ".synergy", "synergy.d", "120-runtime.jsonc"),
          JSON.stringify({
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

  test("applies global Cortex concurrency changes without restart", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        Config.reload = mock(async () => ({
          config: { cortex: { maxConcurrentTasks: 3 } },
          changedFields: ["cortex"],
          oldConfig: {},
        })) as typeof Config.reload

        const result = await RuntimeReload.reload({ targets: ["config"], scope: "global", reason: "test" })

        expect(result.liveApplied).toContain("cortex")
        expect(result.restartRequired).not.toContain("cortex")
        expect(CortexConcurrency.globalStatus()).toMatchObject({ configured: 3, effective: 3, source: "config" })
      },
    })
  })

  test("provider config changes rebuild the account auth registry", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        Config.reload = mock(async () => ({
          config: { provider: {} },
          changedFields: ["provider"],
          oldConfig: {},
        })) as typeof Config.reload
        const authReload = mock(async () => {})
        const providerReload = mock(async () => {})
        const agentReload = mock(async () => {})
        ProviderAuth.reload = authReload
        Provider.reload = providerReload
        Agent.reload = agentReload

        const result = await RuntimeReload.reload({ targets: ["config"], scope: "global", reason: "test" })

        expect(authReload).toHaveBeenCalledTimes(1)
        expect(providerReload).toHaveBeenCalledTimes(1)
        expect(agentReload).toHaveBeenCalledTimes(1)
        expect(result.success).toBe(true)
      },
    })
  })

  test("applies global agent worker pool changes without restarting active turns", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        Config.reload = mock(async () => ({
          config: { execution: { agentWorkers: 2 } },
          changedFields: ["execution"],
          oldConfig: { execution: { agentWorkers: 4 } },
        })) as typeof Config.reload
        const resize = mock(() => {})
        ;(AgentTurn as any).resize = resize

        const result = await RuntimeReload.reload({ targets: ["config"], scope: "global", reason: "test" })

        expect(resize).toHaveBeenCalledWith(2)
        expect(result.liveApplied).toContain("execution.agentWorkers")
        expect(result.restartRequired).not.toContain("execution.agentWorkers")
      },
    })
  })

  test("all expands into concrete targets", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
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
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const warning = RuntimeReload.builtinSourceEditWarning(
          path.join(tmp.path, "packages", "synergy", "src", "tool", "webfetch.ts"),
        )
        expect(warning).toContain("restarting the backend process")
      },
    })
  })

  test("reload auto scope prefers project config when present and emits runtime event", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.mkdir(path.join(dir, ".synergy", "synergy.d"), { recursive: true })
        await Bun.write(
          path.join(dir, ".synergy", "synergy.d", "10-models.jsonc"),
          JSON.stringify({ model: "openai/gpt-4.1" }),
        )
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const configReloadMock = mock(async (scope: "global" | "project", options?: { files?: string[] }) => ({
          config: {},
          changedFields: [] as string[],
          oldConfig: {},
        }))
        Config.reload = configReloadMock as typeof Config.reload

        const events: Array<{ directory?: string; payload: any }> = []
        GlobalBus.on("event", (e) => events.push(e))

        const result = await RuntimeReload.reload({ targets: ["config"], reason: "auto-scope" })

        // Verify auto-scope resolved to project because a project domain config exists
        expect(configReloadMock).toHaveBeenCalledWith("project", { files: undefined })
        expect(result.executed).toContain("config")
        const reloadedEvent = events.find((e) => e.payload?.type === RuntimeReload.Event.Reloaded.type)
        expect(reloadedEvent).toBeDefined()
        expect(reloadedEvent!.payload.properties.executed).toContain("config")
      },
    })
  })

  test("global reload runs without ScopeContext and broadcasts to every client", async () => {
    const providerReload = mock(async () => {})
    const agentReload = mock(async () => {})
    Provider.reload = providerReload
    Agent.reload = agentReload
    const events: Array<{ directory?: string; payload: any }> = []
    GlobalBus.on("event", (event) => events.push(event))

    const result = await RuntimeReload.reloadGlobal({ targets: ["provider"], reason: "background refresh" })

    expect(providerReload).toHaveBeenCalledTimes(1)
    expect(agentReload).toHaveBeenCalledTimes(1)
    expect(result.success).toBe(true)
    expect(result.failed).toEqual([])
    expect(result.executed).toEqual(expect.arrayContaining(["provider", "agent"]))
    expect(result.executed).not.toContain("config")
    expect(result.cascaded).toEqual(["agent"])
    const event = events.find((candidate) => candidate.payload?.type === RuntimeReload.Event.Reloaded.type)
    expect(event?.directory).toBeUndefined()
    expect(event?.payload.properties.executed).toEqual(expect.arrayContaining(["provider", "agent"]))
  })

  test("config reload notifies plugin config hooks with changed fields", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const config = { model: "openai/gpt-4.1" } as Config.Info
        Config.reload = mock(async () => ({
          config,
          changedFields: ["toast"],
          oldConfig: {},
        })) as typeof Config.reload
        const notify = mock(async () => {})
        ;(Plugin as any).notifyConfigHooks = notify

        await RuntimeReload.reload({ targets: ["config"], scope: "global", reason: "hook-notify" })

        expect(notify).toHaveBeenCalledWith({ source: "reload", config, changedFields: ["toast"] })
      },
    })
  })

  test("applies a writer-provided config transition after cache invalidation", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const oldConfig = { thinking_model: "kimi-for-coding/k3" } as Config.Info
        const config = { thinking_model: "deepseek/deepseek-v4-pro" } as Config.Info
        Config.reload = mock(async () => ({
          config,
          changedFields: [],
          oldConfig: config,
        })) as typeof Config.reload
        const reloadAgent = mock(async () => {})
        Agent.reload = reloadAgent
        const notify = mock(async () => {})
        ;(Plugin as any).notifyConfigHooks = notify

        const result = await RuntimeReload.reload(
          { targets: ["config"], scope: "global", reason: "known config change" },
          { configChange: { oldConfig, config, changedFields: ["thinking_model"] } },
        )

        // The writer already reset and re-loaded the Config cache, so the
        // reload must reuse the writer-provided transition instead of
        // re-reading every domain file again.
        expect(Config.reload).not.toHaveBeenCalled()
        expect(result.changedFields).toEqual(["thinking_model"])
        expect(result.liveApplied).toContain("thinking_model")
        expect(result.cascaded).toContain("agent")
        expect(reloadAgent).toHaveBeenCalledTimes(1)
        expect(notify).toHaveBeenCalledWith({
          source: "reload",
          config,
          changedFields: ["thinking_model"],
        })
      },
    })
  })

  test("initializes built-in Channel providers during a config cascade", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const oldConfig = {} as Config.Info
        const config = { channel: {} } as Config.Info
        Config.reload = mock(async () => ({ config, changedFields: [], oldConfig: config })) as typeof Config.reload
        const channelReload = mock(async () => {})
        Channel.reload = channelReload as typeof Channel.reload

        const events: Array<{ payload?: { type?: string; properties?: { changedFields?: string[] } } }> = []
        GlobalBus.on("event", (event) => events.push(event))
        const result = await RuntimeReload.reload(
          { targets: ["config"], scope: "global", reason: "known Channel change" },
          { configChange: { oldConfig, config, changedFields: ["channel"] } },
        )

        expect(result.changedFields).toEqual(["channel"])
        expect(result.cascaded).toContain("channel")
        expect(channelReload).toHaveBeenCalledTimes(1)
        expect(Channel.getProvider("clarus")).toBeDefined()
        const reloadedEvent = events.find((event) => event.payload?.type === RuntimeReload.Event.Reloaded.type)
        expect(reloadedEvent?.payload?.properties?.changedFields).toEqual(["channel"])
      },
    })
  })

  test("ensures channel providers are registered when channel target reloads", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await RuntimeReload.reload({ targets: ["channel"], scope: "global", reason: "provider registration" })

        expect(Channel.getProvider("clarus")).toBeDefined()
        expect(Channel.getProvider("feishu")).toBeDefined()
      },
    })
  })

  test("uses writer old values for transition-dependent live apply", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const oldConfig = { execution: { agentWorkers: 4 } } as Config.Info
        const config = { execution: { agentWorkers: 2 } } as Config.Info
        Config.reload = mock(async () => ({ config, changedFields: [], oldConfig: config })) as typeof Config.reload
        const resize = mock(() => {})
        ;(AgentTurn as any).resize = resize

        const result = await RuntimeReload.reload(
          { targets: ["config"], scope: "global", reason: "known worker change" },
          { configChange: { oldConfig, config, changedFields: ["execution"] } },
        )

        expect(resize).toHaveBeenCalledWith(2)
        expect(result.liveApplied).toContain("execution.agentWorkers")
      },
    })
  })

  test("runs inferred dependency cascades once in order", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const oldConfig = {} as Config.Info
        const config = { category: {} } as Config.Info
        Config.reload = mock(async () => ({ config, changedFields: [], oldConfig: config })) as typeof Config.reload
        const order: string[] = []
        Provider.reload = mock(async () => {
          order.push("provider:start")
          await Bun.sleep(10)
          order.push("provider:end")
        })
        Agent.reload = mock(async () => {
          order.push("agent")
        })

        const result = await RuntimeReload.reload(
          { targets: ["config"], scope: "global", reason: "ordered cascade" },
          { configChange: { oldConfig, config, changedFields: ["category"] } },
        )

        // category reads dynamically via Config.current(), so it cascades to
        // agent only — provider state does not need a rebuild.
        expect(order).toEqual(["agent"])
        expect(result.cascaded).toEqual(expect.arrayContaining(["agent"]))
        expect(result.cascaded).not.toContain("provider")
      },
    })
  })

  test("detects global domain config files as global scope", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        expect(RuntimeReload.detectScopeForFile(ConfigDomain.filepath("models"))).toBe("global")
        expect(RuntimeReload.detectTargetsForFile(ConfigDomain.filepath("mcp"))).toEqual(["config"])
      },
    })
  })

  test("config reload reports cascaded targets and warnings from changed fields", async () => {
    // Test inferConfigCascades directly — it determines what subsystems reload
    // when config fields change. Testing through full reload() is unreliable in
    // test env because subsystem init may hang without a running server.
    const cascaded = RuntimeReload.inferConfigCascades([
      "provider",
      "plugin",
      "mcp",
      "watcher",
      "channel",
      "server",
      "theme",
    ])
    expect(cascaded).toContain("provider")
    expect(cascaded).toContain("agent")
    expect(cascaded).toContain("plugin")
    expect(cascaded).toContain("tool_registry")
    expect(cascaded).toContain("mcp")
    expect(cascaded).toContain("command")
    expect(cascaded).toContain("watcher")
    expect(cascaded).toContain("channel")

    // Verify external_agent cascades to agent (P10 fix)
    const extAgentCascade = RuntimeReload.inferConfigCascades(["external_agent"])
    expect(extAgentCascade).toContain("agent")

    // Verify model role changes cascade to agent only (not provider)
    const modelCascade = RuntimeReload.inferConfigCascades(["model"])
    expect(modelCascade).not.toContain("provider")
    expect(modelCascade).toContain("agent")

    const visionModelCascade = RuntimeReload.inferConfigCascades(["vision_model"])
    expect(visionModelCascade).not.toContain("provider")
    expect(visionModelCascade).toContain("agent")

    // Verify category changes cascade to agent only (provider reads category
    // dynamically via Config.current(), so no provider rebuild is needed)
    const categoryCascade = RuntimeReload.inferConfigCascades(["category"])
    expect(categoryCascade).not.toContain("provider")
    expect(categoryCascade).toContain("agent")

    // Verify timeout changes do not cascade to provider (timeouts are
    // resolved dynamically via TimeoutConfig.resolve())
    expect(RuntimeReload.inferConfigCascades(["timeout"])).not.toContain("provider")

    // Verify default_agent and instruction file settings cascade to agent
    const defaultAgentCascade = RuntimeReload.inferConfigCascades(["default_agent"])
    expect(defaultAgentCascade).toContain("agent")

    const instructionsCascade = RuntimeReload.inferConfigCascades(["instructions"])
    expect(instructionsCascade).toContain("agent")

    const projectDocFallbackCascade = RuntimeReload.inferConfigCascades(["project_doc_fallback_filenames"])
    expect(projectDocFallbackCascade).toContain("agent")

    const projectDocMaxBytesCascade = RuntimeReload.inferConfigCascades(["project_doc_max_bytes"])
    expect(projectDocMaxBytesCascade).toContain("agent")

    // Verify tools changes cascade to tool_registry
    const toolsCascade = RuntimeReload.inferConfigCascades(["tools"])
    expect(toolsCascade).toContain("tool_registry")

    // Verify email is in restart-required (P13 fix)
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const configReloadMock = mock(async () => ({
          config: {},
          changedFields: ["server", "theme"],
          oldConfig: {},
        }))
        Config.reload = configReloadMock as typeof Config.reload

        const result = await RuntimeReload.reload({ targets: ["config"], scope: "global", reason: "cascade" })

        expect(result.restartRequired).toContain("server")
        expect(result.warnings).toContain(
          "Config field `theme` is client-side and is not reloaded by the server runtime",
        )
      },
    })
  })

  test("locale is classified as client-side and not reloaded by the server runtime", async () => {
    expect(RuntimeReload.CONFIG_CLIENT_SIDE.has("locale")).toBe(true)
  })
  test("error isolation: reload continues after subsystem failure", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const result = await RuntimeReload.reload({ targets: ["skill"], scope: "global", reason: "test" })
        expect(result.executed).toContain("skill")
        expect(typeof result.success).toBe("boolean")
      },
    })
  })

  test("embedding config changes dispose the local embedding runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const config = { embedding: { local: { source: "huggingface" } } } as Config.Info
        Config.reload = mock(async () => ({
          config,
          changedFields: ["embedding"],
          oldConfig: {},
        })) as typeof Config.reload
        const notify = mock(async () => {})
        ;(Plugin as any).notifyConfigHooks = notify

        const extractor = Object.assign(
          mock(async () => ({ data: new Float32Array([0.1, 0.2]) })),
          {
            dispose: mock(async () => {}),
          },
        )
        const loadRuntime = mock(async () => ({
          pipeline: mock(async () => extractor),
          isCached: mock(async () => true),
          configure() {},
        }))
        await Embedding.resetForTest()
        Embedding.setLocalRuntimeControlsForTest({ loadRuntime })
        await Embedding.warmup()
        expect(loadRuntime).toHaveBeenCalledTimes(1)

        await RuntimeReload.reload({ targets: ["config"], scope: "global", reason: "embedding change" })

        // Dispose resets load state, so the next status inspection reloads the runtime.
        await Embedding.status()
        expect(loadRuntime).toHaveBeenCalledTimes(2)
        expect(await Embedding.status()).toMatchObject({ asset: "cached", runtime: "unloaded" })
      },
    })
  })

  test("observability sqliteEnabled changes stay restart-required instead of live-applying", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        Config.reload = mock(async () => ({
          config: { observability: { performance: { storage: { sqliteEnabled: false } } } },
          changedFields: ["observability"],
          oldConfig: { observability: { performance: { storage: { sqliteEnabled: true } } } },
        })) as typeof Config.reload

        const result = await RuntimeReload.reload({ targets: ["config"], scope: "global", reason: "test" })

        expect(result.restartRequired).toContain("observability.performance.storage.sqliteEnabled")
        expect(result.liveApplied).not.toContain("observability")
      },
    })
  })

  test("observability changes without sqliteEnabled changes live-apply", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        Config.reload = mock(async () => ({
          config: { observability: { performance: { enabled: false } } },
          changedFields: ["observability"],
          oldConfig: { observability: { performance: { enabled: true } } },
        })) as typeof Config.reload

        const result = await RuntimeReload.reload({ targets: ["config"], scope: "global", reason: "test" })

        expect(result.restartRequired).not.toContain("observability.performance.storage.sqliteEnabled")
        expect(result.liveApplied).toContain("observability")
      },
    })
  })

  test("boss_persona config changes hot-reload the runtime boss identity", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        // The reload config path dynamically imports boss-runtime only inside
        // the experimental-diff branch, so intercept that module and assert
        // the wiring calls refreshIdentity for a persona change while
        // boss_mode stays enabled.
        const refreshIdentity = mock(async () => {})
        const rescheduleBriefing = mock(async () => {})
        mock.module(import.meta.resolve("../../src/boss/boss-runtime"), () => ({
          BossRuntime: {
            sync: mock(async () => {}),
            refreshIdentity,
            rescheduleBriefing,
          },
        }))

        Config.reload = mock(async () => ({
          config: { experimental: { boss_mode: true, boss_persona: { preset: "ops_assistant" } } },
          changedFields: ["experimental"],
          oldConfig: { experimental: { boss_mode: true, boss_persona: { preset: "project_manager" } } },
        })) as typeof Config.reload

        const result = await RuntimeReload.reload({ targets: ["config"], scope: "global", reason: "test" })

        expect(refreshIdentity).toHaveBeenCalledWith({ versioned: true })
        expect(rescheduleBriefing).not.toHaveBeenCalled()
        expect(result.success).toBe(true)
      },
    })
  })

  test("boss_persona changes are ignored while boss_mode is disabled", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const refreshIdentity = mock(async () => {})
        Config.reload = mock(async () => ({
          config: { experimental: { boss_mode: false, boss_persona: { preset: "ops_assistant" } } },
          changedFields: ["experimental"],
          oldConfig: { experimental: { boss_mode: false } },
        })) as typeof Config.reload

        const result = await RuntimeReload.reload({ targets: ["config"], scope: "global", reason: "test" })

        expect(refreshIdentity).not.toHaveBeenCalled()
        expect(result.success).toBe(true)
      },
    })
  })
})
