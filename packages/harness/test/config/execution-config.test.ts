import { expect, test } from "bun:test"
import path from "node:path"
import { LegacyExecutionConfig } from "../../src/config/legacy-execution"
import { Config } from "../../src/config/config"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

test("legacy optional execution fields remain intact when their owners are absent", () =>
  runtime.run(() => {
    const source = {
      experimental: {
        coauthor_reminder: false,
        mcp_timeout: 99,
        boss_mode: true,
        futureOwner: { value: 7 },
      },
    }
    expect(LegacyExecutionConfig.migrate(source)).toEqual({
      prompt: { coauthorReminder: false },
      experimental: { mcp_timeout: 99, boss_mode: true, futureOwner: { value: 7 } },
    })
    expect(source.experimental.coauthor_reminder).toBe(false)
  }))

test("retired experimental environment variables are ignored while ordinary legacy configuration still migrates", () =>
  runtime.run(() => {
    expect(
      LegacyExecutionConfig.environment({
        SYNERGY_EXPERIMENTAL: "1",
        SYNERGY_DISABLE_MESSAGE_CACHE: "true",
        SYNERGY_EXPERIMENTAL_LSP_TY: "true",
      }),
    ).toEqual({
      execution: { messageCache: { enabled: false } },
    })
    expect(LegacyExecutionConfig.environment({ SYNERGY_DISABLE_PRUNE: "false" })).toEqual({})
  }))

test("execution rejects malformed project fragments and leaves the source available for repair", () =>
  runtime.run(async () => {
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
  }))

test("execution snapshots retain winning configuration layers and experiment precedence", () =>
  runtime.run(async () => {
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
        const file = Experiment.File.parse({
          version: 1,
          label: "override",
          overrides: { compaction: { auto: false } },
        })
        const snapshot = Experiment.capture(resolved.config, file, {}, resolved.sources)
        expect(snapshot.sources["compaction.prune"]).toBe("project_config")
        expect(snapshot.sources["compaction.auto"]).toBe("experiment")
        expect(snapshot.sources["compaction.overflowThreshold"]).toBe("default")
      },
    })
  }))

afterRuntimeTests(() => runtime.close())
