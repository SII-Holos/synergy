import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Config } from "../../src/config/config"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { InstructionFiles } from "../../src/session/instruction-files"
import { SystemPrompt } from "../../src/session/system"
import type { Workspace } from "../../src/session/types"
import { Log } from "../../src/util/log"
import { tmpdir } from "../support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

runtime.run(() => Log.init({ print: false }))

async function customPromptFor(scope: Scope, workspacePath?: string) {
  return ScopeContext.provide({
    scope,
    workspace: workspacePath
      ? ({ type: "main", path: workspacePath, scopeID: scope.id } satisfies Workspace)
      : undefined,
    fn: async () => {
      await Config.state.reset()
      return SystemPrompt.custom()
    },
  })
}

async function loadPromptFor(scope: Scope, workspacePath?: string) {
  return ScopeContext.provide({
    scope,
    workspace: workspacePath
      ? ({ type: "main", path: workspacePath, scopeID: scope.id } satisfies Workspace)
      : undefined,
    fn: () => SystemPrompt.custom(),
  })
}

describe("instruction files", () => {
  test("prefers AGENTS.override.md over AGENTS.md", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "AGENTS.md"), "base doc")
          await Bun.write(path.join(dir, "AGENTS.override.md"), "override doc")
        },
      })

      const parts = await customPromptFor(await tmp.scope())
      const joined = parts.join("\n\n")

      expect(joined).toContain("override doc")
      expect(joined).not.toContain("base doc")
    }))

  test("uses configured project doc fallback when AGENTS.md is missing", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({
        git: true,
        config: { project_doc_fallback_filenames: ["PRODUCT.md", "WORKFLOW.md"] },
        init: async (dir) => {
          await Bun.write(path.join(dir, "PRODUCT.md"), "product doc")
          await Bun.write(path.join(dir, "WORKFLOW.md"), "workflow doc")
        },
      })

      const parts = await customPromptFor(await tmp.scope())
      const joined = parts.join("\n\n")

      expect(joined).toContain("product doc")
      expect(joined).not.toContain("workflow doc")
    }))

  test("prefers AGENTS.md over configured fallback files", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({
        git: true,
        config: { project_doc_fallback_filenames: ["PRODUCT.md"] },
        init: async (dir) => {
          await Bun.write(path.join(dir, "AGENTS.md"), "agents doc")
          await Bun.write(path.join(dir, "PRODUCT.md"), "product doc")
        },
      })

      const parts = await customPromptFor(await tmp.scope())
      const joined = parts.join("\n\n")

      expect(joined).toContain("agents doc")
      expect(joined).not.toContain("product doc")
    }))

  test("loads scope-root to workspace instruction files in order", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          const nested = path.join(dir, "packages", "app")
          await fs.mkdir(nested, { recursive: true })
          await Bun.write(path.join(dir, "AGENTS.md"), "root doc")
          await Bun.write(path.join(nested, "AGENTS.md"), "nested doc")
        },
      })

      const nested = path.join(tmp.path, "packages", "app")
      const parts = await customPromptFor(await tmp.scope(), nested)
      const joined = parts.join("\n\n")

      expect(joined.indexOf("root doc")).toBeGreaterThanOrEqual(0)
      expect(joined.indexOf("nested doc")).toBeGreaterThan(joined.indexOf("root doc"))
    }))
  test("deduplicates byte-identical instruction files keeping the nearest source", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          const nested = path.join(dir, "packages", "app")
          await fs.mkdir(nested, { recursive: true })
          await Bun.write(path.join(dir, "AGENTS.md"), "shared repo rules")
          await Bun.write(path.join(nested, "AGENTS.md"), "shared repo rules")
        },
      })

      const nested = path.join(tmp.path, "packages", "app")
      const parts = await customPromptFor(await tmp.scope(), nested)
      const matching = parts.filter((part) => part.includes("shared repo rules"))

      expect(matching).toHaveLength(1)
      expect(matching[0]).toContain(path.join(nested, "AGENTS.md"))
    }))

  test("loads global instructions before project-specific instructions", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          const nested = path.join(dir, "packages", "app")
          await fs.mkdir(nested, { recursive: true })
          await Bun.write(path.join(dir, "AGENTS.md"), "project root doc")
          await Bun.write(path.join(nested, "AGENTS.md"), "project nested doc")
        },
      })
      const home = runtime.host.home

      try {
        const configDir = path.join(home, ".synergy", "config")
        await fs.mkdir(configDir, { recursive: true })
        await Bun.write(path.join(configDir, "AGENTS.override.md"), "global doc")

        const parts = await customPromptFor(await tmp.scope(), path.join(tmp.path, "packages", "app"))
        const joined = parts.join("\n\n")

        expect(joined.indexOf("global doc")).toBeGreaterThanOrEqual(0)
        expect(joined.indexOf("project root doc")).toBeGreaterThan(joined.indexOf("global doc"))
        expect(joined.indexOf("project nested doc")).toBeGreaterThan(joined.indexOf("project root doc"))
      } finally {
        await Config.state.resetAll()
        await fs.rm(path.join(home, ".synergy", "config", "AGENTS.override.md"), { force: true })
      }
    }))

  test("does not search above the active scope", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const inner = path.join(dir, "inner")
          await fs.mkdir(inner, { recursive: true })
          await Bun.write(path.join(dir, "AGENTS.md"), "outer doc")
          await Bun.write(path.join(inner, "AGENTS.md"), "inner doc")
        },
      })

      const inner = path.join(tmp.path, "inner")
      const scope = (await Scope.fromDirectory(inner)).scope
      const parts = await customPromptFor(scope)
      const joined = parts.join("\n\n")

      expect(joined).toContain("inner doc")
      expect(joined).not.toContain("outer doc")
    }))

  test("truncates automatically discovered instruction files", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({
        git: true,
        config: { project_doc_max_bytes: 4 },
        init: async (dir) => {
          await Bun.write(path.join(dir, "AGENTS.md"), "abcdef")
        },
      })

      const parts = await customPromptFor(await tmp.scope())
      const joined = parts.join("\n\n")

      expect(joined).toContain("abcd")
      expect(joined).not.toContain("abcde")
    }))

  test("reuses loaded parts across rounds of one turn and refreshes them when the configuration reloads", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "AGENTS.md"), "first revision")
        },
      })
      const scope = await tmp.scope()
      const doc = path.join(tmp.path, "AGENTS.md")

      await customPromptFor(scope)
      InstructionFiles.resetStatsForTest()

      const first = await loadPromptFor(scope)
      expect(first.join("\n\n")).toContain("first revision")

      const second = await loadPromptFor(scope)
      expect(second.join("\n\n")).toContain("first revision")
      expect(InstructionFiles.stats().fileReads).toBe(0)
      expect(InstructionFiles.stats().fileReuses).toBeGreaterThan(0)

      await Bun.write(doc, "edited without a config reload")
      const edited = await loadPromptFor(scope)
      expect(edited.join("\n\n")).toContain("edited without a config reload")

      await Bun.write(doc, "served after the reload")
      await ScopeContext.provide({ scope, fn: () => Config.state.reset() })
      InstructionFiles.resetStatsForTest()
      const reloaded = await loadPromptFor(scope)
      expect(reloaded.join("\n\n")).toContain("served after the reload")
      expect(reloaded.join("\n\n")).not.toContain("edited without a config reload")
      expect(InstructionFiles.stats().fileReads).toBeGreaterThan(0)
      expect(InstructionFiles.stats().fileReuses).toBe(0)
    }))
})

afterRuntimeTests(() => runtime.close())
