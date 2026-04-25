import { describe, expect, test } from "bun:test"
import { Scope } from "../../src/scope"
import { Info as InfoSchema } from "../../src/scope/types"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import path from "path"
import { $ } from "bun"

Log.init({ print: false })

/**
 * Scope.Info Zod schema must include `type` and `directory` fields
 * to match what the server API routes actually return.
 *
 * The server returns Scope.Project / Scope.Global objects (which have
 * `type` and `directory`), but the Info schema (which drives OpenAPI
 * and SDK types) lacked these fields. This means the frontend SDK type
 * `Scope` cannot type-safely access scope.type or scope.directory.
 *
 * These tests assert the CORRECT behavior — they will FAIL until the
 * schema is fixed to include `type` and `directory`.
 */

describe("Scope.Info schema includes type and directory", () => {
  test("Scope.Info schema has 'type' field", () => {
    expect(InfoSchema.shape).toHaveProperty("type")
  })

  test("Scope.Info schema has 'directory' field", () => {
    expect(InfoSchema.shape).toHaveProperty("directory")
  })

  test("Scope.Info preserves type and directory through parse", () => {
    const data = {
      id: "test-scope-id",
      type: "project" as const,
      directory: "/some/sandbox",
      worktree: "/some/path",
      sandboxes: [] as string[],
      time: { created: Date.now(), updated: Date.now() },
    }

    const result = InfoSchema.parse(data) as any
    expect(result.type).toBe("project")
    expect(result.directory).toBe("/some/sandbox")
  })

  test("Scope.Info rejects data missing 'type'", () => {
    const data = {
      id: "test-scope-id",
      directory: "/some/sandbox",
      worktree: "/some/path",
      sandboxes: [] as string[],
      time: { created: Date.now(), updated: Date.now() },
    }

    const result = InfoSchema.safeParse(data)
    expect(result.success).toBe(false)
  })

  test("Scope.Info rejects data missing 'directory'", () => {
    const data = {
      id: "test-scope-id",
      type: "project" as const,
      worktree: "/some/path",
      sandboxes: [] as string[],
      time: { created: Date.now(), updated: Date.now() },
    }

    const result = InfoSchema.safeParse(data)
    expect(result.success).toBe(false)
  })
})

describe("Scope.Info can represent Scope.Project from fromDirectory", () => {
  test("Scope.Info validates Scope.Project returned by fromDirectory", async () => {
    await using tmp = await tmpdir({ git: true })

    const { scope } = await Scope.fromDirectory(tmp.path)

    const result = InfoSchema.safeParse(scope)
    expect(result.success).toBe(true)
    if (result.success) {
      const parsed = result.data as any
      expect(parsed.type).toBe("project")
      expect(parsed.directory).toBe(tmp.path)
    }
  })

  test("Scope.Info preserves directory as sandbox for linked worktrees", async () => {
    await using tmp = await tmpdir({ git: true })

    const worktreePath = path.join(tmp.path, "..", `wt-info-${Math.random().toString(36).slice(2)}`)
    await $`git worktree add ${worktreePath} -b wt-info-branch`.cwd(tmp.path).quiet()

    const { scope } = await Scope.fromDirectory(worktreePath)

    const result = InfoSchema.safeParse(scope)
    expect(result.success).toBe(true)
    if (result.success) {
      const parsed = result.data as any
      // directory should be the sandbox (actual checkout), not the worktree root
      expect(parsed.directory).toBe(worktreePath)
      expect(parsed.worktree).toBe(tmp.path)
    }

    await $`git worktree remove ${worktreePath}`.cwd(tmp.path).quiet()
  })
})

describe("Scope.Info can represent Scope.list results", () => {
  test("Scope.Info validates each scope returned by Scope.list with type and directory", async () => {
    await using tmp = await tmpdir({ git: true })
    const { scope: resolved } = await Scope.fromDirectory(tmp.path)

    const scopes = await Scope.list()
    const found = scopes.find((s) => s.id === resolved.id)
    expect(found).toBeDefined()
    if (!found) return

    const result = InfoSchema.safeParse(found)
    expect(result.success).toBe(true)
    if (result.success) {
      const parsed = result.data as any
      expect(parsed.type).toBe("project")
      expect(parsed.directory).toBeDefined()
    }
  })
})

describe("Scope.Info type field distinguishes global from project", () => {
  test("type field allows 'global' value", () => {
    const data = {
      id: "global",
      type: "global" as const,
      directory: "/home/user",
      worktree: "/home/user",
      sandboxes: [] as string[],
      time: { created: Date.now(), updated: Date.now() },
    }

    const result = InfoSchema.safeParse(data)
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as any).type).toBe("global")
    }
  })

  test("type field allows 'project' value", () => {
    const data = {
      id: "some-hash",
      type: "project" as const,
      directory: "/some/repo",
      worktree: "/some/repo",
      sandboxes: [] as string[],
      time: { created: Date.now(), updated: Date.now() },
    }

    const result = InfoSchema.safeParse(data)
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as any).type).toBe("project")
    }
  })

  test("type field rejects invalid values", () => {
    const data = {
      id: "test-id",
      type: "invalid",
      directory: "/some/path",
      worktree: "/some/path",
      sandboxes: [] as string[],
      time: { created: Date.now(), updated: Date.now() },
    }

    const result = InfoSchema.safeParse(data)
    expect(result.success).toBe(false)
  })
})
