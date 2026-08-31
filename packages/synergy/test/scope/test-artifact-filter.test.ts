import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import fs from "fs/promises"
import { Scope } from "../../src/scope"
import { isEphemeralTestWorktree, isEphemeralTestWorktreeBasename } from "../../src/scope/test-artifacts"

describe("isEphemeralTestWorktree", () => {
  test("matches synergy-test-* basenames under the OS temp dir", () => {
    expect(isEphemeralTestWorktree(`${os.tmpdir()}/synergy-test-abc`)).toBe(true)
    expect(isEphemeralTestWorktree(`${os.tmpdir()}/synergy-test-y4xq0p7sllc`)).toBe(true)
  })

  test("matches synergy-orchestrated-* basenames under the OS temp dir", () => {
    expect(isEphemeralTestWorktree(`${os.tmpdir()}/synergy-orchestrated-123-abc`)).toBe(true)
  })

  test("rejects real project directories whose basename is not a test prefix", () => {
    expect(isEphemeralTestWorktree("/Users/eric/projects/synergy-test")).toBe(false)
    expect(isEphemeralTestWorktree("/Users/eric/projects/synergy-test/3d-software-rasterizer-pro")).toBe(false)
    expect(isEphemeralTestWorktree("/Users/eric/projects/synergy/packages/synergy")).toBe(false)
    expect(
      isEphemeralTestWorktree("/Users/eric/projects/synergy/.synergy/worktrees/plugin-mcp-v3-local/packages/synergy"),
    ).toBe(false)
  })

  test("rejects a matching basename outside the OS temp dir", () => {
    // The directory does not exist, so the realpath secondary guard fails and
    // the worktree is not treated as ephemeral (it is not inside tmp).
    expect(isEphemeralTestWorktree("/nonexistent-root/synergy-test-abc")).toBe(false)
  })

  test("basename helper is a pure string match independent of tmpdir", () => {
    expect(isEphemeralTestWorktreeBasename("/var/folders/x/T/synergy-test-foo")).toBe(true)
    expect(isEphemeralTestWorktreeBasename("/tmp/synergy-orchestrated-9-zz")).toBe(true)
    expect(isEphemeralTestWorktreeBasename("/Users/eric/projects/synergy-test/foo")).toBe(false)
    expect(isEphemeralTestWorktreeBasename("/Users/eric/projects/synergy")).toBe(false)
  })
})

describe("Scope.list() ephemeral test-artifact filtering", () => {
  test("hides a persisted scope whose worktree is an ephemeral test artifact", async () => {
    const dir = path.join(os.tmpdir(), `synergy-test-${Math.random().toString(36).slice(2)}`)
    await fs.mkdir(dir, { recursive: true })
    try {
      const { scope } = await Scope.fromDirectory(dir)
      expect(scope.type).toBe("project")
      // The record is persisted, but the domain list filters it.
      expect(await Scope.fromID(scope.id)).toBeDefined()
      expect((await Scope.list()).some((item) => item.id === scope.id)).toBe(false)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("keeps a real project scope whose basename is not a test prefix", async () => {
    const dir = path.join(os.tmpdir(), `real-project-${Math.random().toString(36).slice(2)}`)
    await fs.mkdir(dir, { recursive: true })
    try {
      const { scope } = await Scope.fromDirectory(dir)
      expect(scope.type).toBe("project")
      expect((await Scope.list()).some((item) => item.id === scope.id)).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
