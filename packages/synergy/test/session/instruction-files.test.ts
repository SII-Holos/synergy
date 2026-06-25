import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Config } from "../../src/config/config"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { SystemPrompt } from "../../src/session/system"
import type { Workspace } from "../../src/session/types"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

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

describe("instruction files", () => {
  test("prefers AGENTS.override.md over AGENTS.md", async () => {
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
  })

  test("uses configured project doc fallback when AGENTS.md is missing", async () => {
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
  })

  test("prefers AGENTS.md over configured fallback files", async () => {
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
  })

  test("loads scope-root to workspace instruction files in order", async () => {
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
  })

  test("does not search above the active scope", async () => {
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
  })

  test("truncates automatically discovered instruction files", async () => {
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
  })
})
