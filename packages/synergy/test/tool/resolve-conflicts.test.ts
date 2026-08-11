import { lstat, mkdir, symlink } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import path from "path"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"
import { ViewFileTool } from "../../src/tool/view-file"
import { ReviseFileTool } from "../../src/tool/revise-file"
import { ResolveConflictsTool } from "../../src/tool/resolve-conflicts"
import { ToolRegistry } from "../../src/tool/registry"

const ctx = {
  sessionID: "test-resolve-conflicts",
  messageID: "",
  callID: "",
  agent: "test-strategist",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

function conflictBlock(ours: string, theirs: string, labels = { ours: "HEAD", theirs: "main" }): string[] {
  return [`<<<<<<< ${labels.ours}`, ours, "=======", theirs, `>>>>>>> ${labels.theirs}`]
}

function conflictedFile(...blocks: string[][]): string {
  return ["before", ...blocks.flatMap((block, index) => [...block, `between-${index + 1}`]), "after", ""].join("\n")
}

async function viewTag(filePath: string): Promise<string> {
  const view = await ViewFileTool.init()
  const result = await view.execute({ filePath }, ctx)
  return result.metadata.tag as string
}

describe("tool.resolve_conflicts", () => {
  test("is registered in the first-party tool registry", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        expect(await ToolRegistry.find("resolve_conflicts")).toBeDefined()
      },
    })
  })

  test.each([
    ["ours", "local"],
    ["theirs", "remote"],
  ] as const)("resolves a single conflict with the %s side", async (strategy, expected) => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "conflict.ts"), conflictedFile(conflictBlock("local", "remote")))
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const filePath = path.join(tmp.path, "conflict.ts")
        const tag = await viewTag(filePath)
        const tool = await ResolveConflictsTool.init()
        const result = await tool.execute(
          {
            filePath,
            tag,
            resolutions: [{ conflict: 1, strategy }],
          },
          ctx,
        )

        expect(result.metadata.resolvedConflicts).toBe(1)
        expect(result.metadata.tag).not.toBe(tag)
        expect(result.metadata.hasConflicts).toBe(false)
        expect(result.output).toMatch(/^\[conflict\.ts#[0-9A-F]{4}\]/)

        const content = await Bun.file(filePath).text()
        expect(content).toContain(`before\n${expected}\nbetween-1`)
        expect(content).not.toContain("<<<<<<<")
        expect(content).not.toContain("=======")
        expect(content).not.toContain(">>>>>>>")
      },
    })
  })

  test("revise_file directs conflicted files to resolve_conflicts", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "blocked.ts"), conflictedFile(conflictBlock("local", "remote")))
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const filePath = path.join(tmp.path, "blocked.ts")
        const tag = await viewTag(filePath)
        const revise = await ReviseFileTool.init()

        await expect(revise.execute({ input: `[blocked.ts#${tag}]\nSWAP 2..2:\n+resolved\n` }, ctx)).rejects.toThrow(
          /resolve_conflicts/,
        )
      },
    })
  })

  test("resolves both sides in the requested order", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "both.ts"), conflictedFile(conflictBlock("local", "remote")))
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const filePath = path.join(tmp.path, "both.ts")
        const tag = await viewTag(filePath)
        const tool = await ResolveConflictsTool.init()
        await tool.execute(
          {
            filePath,
            tag,
            resolutions: [{ conflict: 1, strategy: "both", order: "theirs-ours" }],
          },
          ctx,
        )

        expect(await Bun.file(filePath).text()).toContain("before\nremote\nlocal\nbetween-1")
      },
    })
  })

  test("strips the diff3 base section from the ours resolution", async () => {
    const original = [
      "before",
      "<<<<<<< HEAD",
      "local",
      "||||||| base",
      "ancestor",
      "=======",
      "remote",
      ">>>>>>> main",
      "after",
      "",
    ].join("\n")
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "diff3.ts"), original)
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const filePath = path.join(tmp.path, "diff3.ts")
        const tag = await viewTag(filePath)
        const tool = await ResolveConflictsTool.init()
        await tool.execute(
          { filePath, tag, resolutions: [{ conflict: 1, strategy: "ours", conflictStyle: "diff3" }] },
          ctx,
        )

        expect(await Bun.file(filePath).text()).toBe("before\nlocal\nafter\n")
      },
    })
  })

  test("preserves a UTF-8 BOM and CRLF line endings", async () => {
    const original = `\uFEFFbefore\r\n<<<<<<< HEAD\r\nlocal\r\n=======\r\nremote\r\n>>>>>>> main\r\nafter\r\n`
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "windows.ts"), original)
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const filePath = path.join(tmp.path, "windows.ts")
        const tag = await viewTag(filePath)
        const tool = await ResolveConflictsTool.init()
        await tool.execute({ filePath, tag, resolutions: [{ conflict: 1, strategy: "theirs" }] }, ctx)

        const content = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await Bun.file(filePath).arrayBuffer())
        expect(content).toBe("\uFEFFbefore\r\nremote\r\nafter\r\n")
      },
    })
  })

  test("applies custom content and resolves every conflict atomically", async () => {
    const original = conflictedFile(conflictBlock("first-local", "first-remote"), conflictBlock("second-a", "second-b"))
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "custom.ts"), original)
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const filePath = path.join(tmp.path, "custom.ts")
        const tag = await viewTag(filePath)
        const tool = await ResolveConflictsTool.init()
        const result = await tool.execute(
          {
            filePath,
            tag,
            resolutions: [
              { conflict: 1, strategy: "custom", content: "const merged = 1" },
              { conflict: 2, strategy: "theirs" },
            ],
          },
          ctx,
        )

        expect(result.metadata.resolvedConflicts).toBe(2)
        expect(await Bun.file(filePath).text()).toBe(
          ["before", "const merged = 1", "between-1", "second-b", "between-2", "after", ""].join("\n"),
        )
      },
    })
  })

  test("rejects partial resolution without modifying the file", async () => {
    const original = conflictedFile(conflictBlock("one-a", "one-b"), conflictBlock("two-a", "two-b"))
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "partial.ts"), original)
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const filePath = path.join(tmp.path, "partial.ts")
        const tag = await viewTag(filePath)
        const tool = await ResolveConflictsTool.init()

        await expect(
          tool.execute(
            {
              filePath,
              tag,
              resolutions: [{ conflict: 1, strategy: "ours" }],
            },
            ctx,
          ),
        ).rejects.toThrow(/all 2 conflict blocks|exactly one resolution/i)
        expect(await Bun.file(filePath).text()).toBe(original)
      },
    })
  })

  test("rejects an out-of-date tag without modifying the file", async () => {
    const original = conflictedFile(conflictBlock("local", "remote"))
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "stale.ts"), original)
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const filePath = path.join(tmp.path, "stale.ts")
        const tag = await viewTag(filePath)
        const changed = original.replace("before", "changed-before")
        await Bun.write(filePath, changed)
        const tool = await ResolveConflictsTool.init()

        await expect(
          tool.execute(
            {
              filePath,
              tag,
              resolutions: [{ conflict: 1, strategy: "ours" }],
            },
            ctx,
          ),
        ).rejects.toThrow(/out-of-date|changed since|current tag/i)
        expect(await Bun.file(filePath).text()).toBe(changed)
      },
    })
  })

  test("rejects a symbolic link without replacing it or writing its target", async () => {
    const original = conflictedFile(conflictBlock("local", "remote"))
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "target.ts"), original)
        await symlink("target.ts", path.join(dir, "link.ts"))
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const filePath = path.join(tmp.path, "link.ts")
        const targetPath = path.join(tmp.path, "target.ts")
        const tag = await viewTag(filePath)
        const tool = await ResolveConflictsTool.init()

        await expect(
          tool.execute(
            {
              filePath,
              tag,
              resolutions: [{ conflict: 1, strategy: "ours" }],
            },
            ctx,
          ),
        ).rejects.toThrow(/symbolic link/i)
        expect((await lstat(filePath)).isSymbolicLink()).toBe(true)
        expect(await Bun.file(targetPath).text()).toBe(original)
      },
    })
  })

  test("allows a parent symlink that remains inside the project root", async () => {
    const original = conflictedFile(conflictBlock("local", "remote"))
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await mkdir(path.join(dir, "actual"))
        await Bun.write(path.join(dir, "actual", "inside.ts"), original)
        await symlink("actual", path.join(dir, "alias"))
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const filePath = path.join(tmp.path, "alias", "inside.ts")
        const tag = await viewTag(filePath)
        const tool = await ResolveConflictsTool.init()

        await tool.execute(
          {
            filePath,
            tag,
            resolutions: [{ conflict: 1, strategy: "ours" }],
          },
          ctx,
        )

        expect(await Bun.file(path.join(tmp.path, "actual", "inside.ts")).text()).toBe(
          "before\nlocal\nbetween-1\nafter\n",
        )
      },
    })
  })

  test("rejects a path whose parent symlink escapes the project root", async () => {
    const original = conflictedFile(conflictBlock("local", "remote"))
    await using external = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "outside.ts"), original)
      },
    })
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await symlink(external.path, path.join(dir, "escape"))
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const filePath = path.join(tmp.path, "escape", "outside.ts")
        const tag = await viewTag(filePath)
        const tool = await ResolveConflictsTool.init()

        await expect(
          tool.execute(
            {
              filePath,
              tag,
              resolutions: [{ conflict: 1, strategy: "ours" }],
            },
            ctx,
          ),
        ).rejects.toThrow(/symbolic link|escapes/i)
        expect(await Bun.file(path.join(external.path, "outside.ts")).text()).toBe(original)
      },
    })
  })

  test("rejects file drift during approval without overwriting it", async () => {
    const original = conflictedFile(conflictBlock("local", "remote"))
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "approval-drift.ts"), original)
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const filePath = path.join(tmp.path, "approval-drift.ts")
        const changed = original.replace("before", "changed-during-approval")
        const tag = await viewTag(filePath)
        const tool = await ResolveConflictsTool.init()

        await expect(
          tool.execute(
            {
              filePath,
              tag,
              resolutions: [{ conflict: 1, strategy: "ours" }],
            },
            {
              ...ctx,
              ask: async () => {
                await Bun.write(filePath, changed)
              },
            },
          ),
        ).rejects.toThrow(/out-of-date|changed since|current tag/i)
        expect(await Bun.file(filePath).text()).toBe(changed)
      },
    })
  })

  test("rejects a clean file", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "clean.ts"), "const clean = true\n")
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const filePath = path.join(tmp.path, "clean.ts")
        const tag = await viewTag(filePath)
        const tool = await ResolveConflictsTool.init()

        await expect(
          tool.execute(
            {
              filePath,
              tag,
              resolutions: [{ conflict: 1, strategy: "ours" }],
            },
            ctx,
          ),
        ).rejects.toThrow(/does not contain conflict markers/i)
      },
    })
  })

  test("returns a fresh tag that revise_file can use immediately", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "continue.ts"),
          conflictedFile(conflictBlock("const value = 1", "const value = 2")),
        )
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const filePath = path.join(tmp.path, "continue.ts")
        const tag = await viewTag(filePath)
        const resolve = await ResolveConflictsTool.init()
        const resolved = await resolve.execute(
          {
            filePath,
            tag,
            resolutions: [{ conflict: 1, strategy: "ours" }],
          },
          ctx,
        )

        const revise = await ReviseFileTool.init()
        const revised = await revise.execute(
          {
            input: `[continue.ts#${resolved.metadata.tag}]\nSWAP 2..2:\n+const value = 3\n`,
          },
          ctx,
        )

        expect(revised.metadata.applied).toBe(true)
        expect(await Bun.file(filePath).text()).toContain("const value = 3")
      },
    })
  })
})
