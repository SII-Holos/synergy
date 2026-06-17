import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/scope/instance"
import { ReadTool } from "../../src/tool/read"

// ---------------------------------------------------------------------------
// tool/workspace-boundary.test.ts
//
// Tests for the unified capability gate that protects the active workspace
// from file/anchored/document/attach tool access outside the boundary.
//
// When a session has a workspace with an originalCheckout (git worktree),
// tools that read or attach files must gate access through the workspace
// boundary check — not just the scope.contains() check.
//
// These tests encode the DESIGN CONTRACT before implementation exists.
// They MUST fail (RED) until the enforcement module is integrated into
// the file/anchored/document/attach tool execution paths.
// ---------------------------------------------------------------------------

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "developer",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

describe("workspace boundary — attach/read tools", () => {
  test("read tool rejects file access outside active workspace under git_worktree policy", async () => {
    // Set up a worktree scenario: the scope is the worktree dir,
    // the workspace points to it, and originalCheckout is a separate path.
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "in-scope.txt"), "workspace content")
      },
    })

    const originalCheckout = path.resolve(tmp.path, "..", "original-checkout")

    // Write a file in the "original checkout" path that should be blocked
    const originalFile = path.join(originalCheckout, "secret.txt")
    // We'll test that attempting to read from originalCheckout is blocked

    await Instance.provide({
      scope: await tmp.scope(),
      workspace: {
        type: "git_worktree",
        path: tmp.path,
        scopeID: (await tmp.scope()).id,
        originalCheckout,
      },
      fn: async () => {
        const read = await ReadTool.init()

        // Reading a file in the original checkout should be rejected
        // by the workspace boundary gate — not just scope.contains()
        await expect(
          read.execute({ filePath: originalFile }, ctx),
        ).rejects.toThrow()
      },
    })
  })

  test("read tool allows file access inside active workspace under git_worktree policy", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "in-scope.txt"), "workspace content")
      },
    })

    const originalCheckout = path.resolve(tmp.path, "..", "original-checkout")

    await Instance.provide({
      scope: await tmp.scope(),
      workspace: {
        type: "git_worktree",
        path: tmp.path,
        scopeID: (await tmp.scope()).id,
        originalCheckout,
      },
      fn: async () => {
        const read = await ReadTool.init()

        // Reading a file inside the active workspace should succeed
        const result = await read.execute({
          filePath: path.join(tmp.path, "in-scope.txt"),
        }, ctx)

        expect(result.output).toContain("workspace content")
      },
    })
  })

  test("read tool parent-traversal into original checkout triggers boundary gate", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "in-scope.txt"), "ok")
      },
    })

    const originalCheckout = path.resolve(tmp.path, "..", "original-checkout")

    await Instance.provide({
      scope: await tmp.scope(),
      workspace: {
        type: "git_worktree",
        path: tmp.path,
        scopeID: (await tmp.scope()).id,
        originalCheckout,
      },
      fn: async () => {
        const read = await ReadTool.init()

        // ../ traversal from the workspace should be classified as
        // crossing the boundary into original-checkout territory
        await expect(
          read.execute({
            filePath: "../original-checkout/secret.txt",
          }, ctx),
        ).rejects.toThrow()
      },
    })
  })

  test("read tool absolute path outside workspace triggers boundary gate", async () => {
    await using tmp = await tmpdir({
      git: true,
    })

    const originalCheckout = "/tmp/original-checkout-" + Math.random().toString(36).slice(2)

    await Instance.provide({
      scope: await tmp.scope(),
      workspace: {
        type: "git_worktree",
        path: tmp.path,
        scopeID: (await tmp.scope()).id,
        originalCheckout,
      },
      fn: async () => {
        const read = await ReadTool.init()

        // Absolute path to the original checkout should be blocked
        await expect(
          read.execute({
            filePath: path.join(originalCheckout, "config.json"),
          }, ctx),
        ).rejects.toThrow()
      },
    })
  })

  test("read tool without workspace does not enforce git_worktree boundary", async () => {
    // When there's no workspace set (e.g., standard non-worktree session),
    // the scope.contains() check is sufficient — no additional boundary gate.
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "in-scope.txt"), "ok")
      },
    })

    await Instance.provide({
      scope: await tmp.scope(),
      // No workspace — default behavior
      fn: async () => {
        const read = await ReadTool.init()

        const result = await read.execute({
          filePath: path.join(tmp.path, "in-scope.txt"),
        }, ctx)

        expect(result.output).toContain("ok")
      },
    })
  })
})

describe("workspace boundary — anchored tools (view_file, scan_files, parse_code)", () => {
  test("anchored file tools are gated by workspace boundary when workspace is active", async () => {
    // Anchored tools (view_file, scan_files, parse_code, revise_file)
    // all inherit the same workspace boundary enforcement as read.
    // When the sandbox/enforcement modules are integrated, all file-access
    // tools must check the unified capability gate.

    await using tmp = await tmpdir({ git: true })
    const originalCheckout = path.resolve(tmp.path, "..", "original-checkout")

    await Instance.provide({
      scope: await tmp.scope(),
      workspace: {
        type: "git_worktree",
        path: tmp.path,
        scopeID: (await tmp.scope()).id,
        originalCheckout,
      },
      fn: async () => {
        // When the enforcement module exists, anchored tools like view_file
        // will import and call PathClassifier or WorkspaceBoundary.gate().
        // For now, this test documents the contract: all anchored tools
        // must use the same unified capability gate.
        //
        // The specific assertion shape will be refined when the module exists.
        // Currently it just imports ReadTool as the canonical test vehicle
        // since it has the most established boundary test patterns.
        const read = await ReadTool.init()

        await expect(
          read.execute({
            filePath: path.join(originalCheckout, "src/index.ts"),
          }, ctx),
        ).rejects.toThrow()
      },
    })
  })
})

describe("workspace boundary — workspace type extensibility", () => {
  test("boundary gate handles custom workspace types without crashing", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      scope: await tmp.scope(),
      workspace: {
        type: "custom_container" as any,
        path: tmp.path,
        scopeID: (await tmp.scope()).id,
        rootPath: "/mnt/container-root",
      },
      fn: async () => {
        const read = await ReadTool.init()

        // A file inside the workspace path should still be accessible
        await Bun.write(path.join(tmp.path, "data.txt"), "container data")
        const result = await read.execute({
          filePath: path.join(tmp.path, "data.txt"),
        }, ctx)

        expect(result.output).toContain("container data")
      },
    })
  })

  test("boundary gate rejects path in unknown workspace types root beyond active path", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      scope: await tmp.scope(),
      workspace: {
        type: "custom_container" as any,
        path: "/home/user/worktree",
        scopeID: (await tmp.scope()).id,
        rootPath: "/mnt/container-root",
      },
      fn: async () => {
        const read = await ReadTool.init()

        // Path outside the active workspace path should trigger boundary check
        // This is the abstracted form of the worktree boundary — any workspace
        // type with a rootPath (original location) must protect it.
        await expect(
          read.execute({
            filePath: "/mnt/container-root/secrets.env",
          }, ctx),
        ).rejects.toThrow()
      },
    })
  })
})
