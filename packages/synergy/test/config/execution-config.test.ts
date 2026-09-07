import { expect, test } from "bun:test"
import path from "node:path"
import { LegacyExecutionConfig } from "../../src/config/legacy-execution"
import { migrateExecutionConfigFile } from "../../src/config/migration"
import { Config } from "../../src/config/config"
import { ConfigLspCatalog } from "../../src/config/lsp-catalog"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

test("legacy environment behavior is resolved at the input boundary with explicit false preserved", () => {
  expect(
    LegacyExecutionConfig.environment({
      SYNERGY_EXPERIMENTAL: "1",
      SYNERGY_DISABLE_MESSAGE_CACHE: "true",
      SYNERGY_EXPERIMENTAL_LSP_TY: "true",
    }),
  ).toEqual({
    execution: { messageCache: { enabled: false } },
    formatter: { oxfmt: { disabled: false } },
    toolExposure: { lsp: true },
    lsp: { ty: { disabled: false }, pyright: { disabled: true } },
  })
  expect(LegacyExecutionConfig.environment({ SYNERGY_DISABLE_PRUNE: "false" })).toEqual({})
})

test("domain migration preserves legacy timeout priority and moves prompts without losing sibling values", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "120-runtime.jsonc")
  await Bun.write(
    path.join(tmp.path, "40-mcp.jsonc"),
    JSON.stringify({ mcpDefaults: { callTimeout: 10, connectTimeout: 20 } }),
  )
  await Bun.write(path.join(tmp.path, "60-agents.jsonc"), JSON.stringify({ default_agent: "synergy" }))
  await Bun.write(
    file,
    JSON.stringify({ experimental: { mcp_timeout: 99, coauthor_reminder: false, boss_mode: true, batch_tool: true } }),
  )
  expect(await migrateExecutionConfigFile(file)).toBe(true)
  expect(await Bun.file(file).json()).toEqual({ boss: { enabled: true } })
  expect(await Bun.file(path.join(tmp.path, "40-mcp.jsonc")).json()).toEqual({
    mcpDefaults: { callTimeout: 99, connectTimeout: 20 },
  })
  expect(await Bun.file(path.join(tmp.path, "60-agents.jsonc")).json()).toEqual({
    default_agent: "synergy",
    prompt: { coauthorReminder: false },
  })
  expect(await migrateExecutionConfigFile(file)).toBe(false)
})

test("built-in LSP enablement accepts partial configuration while custom servers need commands", () => {
  ConfigLspCatalog.registerServerIds(["ty", "pyright"])
  expect(Config.Info.safeParse({ lsp: { ty: { disabled: false }, pyright: { disabled: true } } }).success).toBe(true)
  expect(Config.Info.safeParse({ lsp: { unknown: { disabled: false } } }).success).toBe(false)
  expect(Config.Info.safeParse({ lsp: { ty: { env: { TEST: "1" } } } }).success).toBe(false)
})

test("execution rejects malformed project fragments and leaves the source available for repair", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, ".synergy/synergy.d/120-runtime.jsonc"), '{ "compaction": broken }')
    },
  })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      await expect(Config.resolveExecution()).rejects.toThrow("Invalid config fragment")
      expect(await Bun.file(path.join(tmp.path, ".synergy/synergy.d/120-runtime.jsonc")).text()).toContain("broken")
    },
  })
})

test("execution snapshots retain winning configuration layers and experiment precedence", async () => {
  const { Experiment } = await import("../../src/config/experiment")
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, ".synergy/synergy.d/120-runtime.jsonc"),
        JSON.stringify({ compaction: { prune: false } }),
      )
    },
  })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const resolved = await Config.resolveExecutionDetails()
      const file = Experiment.File.parse({ version: 1, label: "override", overrides: { compaction: { auto: false } } })
      const snapshot = Experiment.capture(resolved.config, file, {}, resolved.sources)
      expect(snapshot.sources["compaction.prune"]).toBe("project_config")
      expect(snapshot.sources["compaction.auto"]).toBe("experiment")
      expect(snapshot.sources["compaction.overflowThreshold"]).toBe("default")
    },
  })
})
