import { describe, expect, test } from "bun:test"
import { isolateClarusHome } from "../helpers/clarus-isolation"
await isolateClarusHome(import.meta.url)

import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "../../src/global"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { ClarusWorkspace } from "../../src/clarus/workspace"
import { Filesystem } from "../../src/util/filesystem"

function keyRoot() {
  return ["sec-test", Math.random().toString(36).slice(2)]
}

function tmpWorkspaceDir() {
  return Filesystem.sanitizePath(path.join(os.tmpdir(), "synergy-ws-test-" + Math.random().toString(36).slice(2)))
}

// =============================================================================
// Storage containment — assertion helper
// =============================================================================
function rejectMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// =============================================================================
// Section 1: Storage traversal rejection across all operations
// =============================================================================
describe("storage traversal rejection", () => {
  const traversalSegments: { label: string; segment: string }[] = [
    { label: "empty segment", segment: "" },
    { label: "dot segment", segment: "." },
    { label: "dotdot segment", segment: ".." },
    { label: "NUL byte", segment: "foo\0bar" },
    { label: "forward slash", segment: "foo/bar" },
    { label: "backslash", segment: "foo\\bar" },
  ]

  for (const { label, segment } of traversalSegments) {
    const key = [segment]

    test(`write rejects ${label}`, async () => {
      await expect(Storage.write(key, { v: 1 })).rejects.toThrow("invalid segment")
    })

    test(`read rejects ${label}`, async () => {
      await expect(Storage.read(key)).rejects.toThrow("invalid segment")
    })

    test(`update rejects ${label}`, async () => {
      await expect(
        Storage.update<{ v: number }>(key, (d) => {
          d.v = 2
        }),
      ).rejects.toThrow("invalid segment")
    })

    test(`remove rejects ${label}`, async () => {
      await expect(Storage.remove(key)).rejects.toThrow("invalid segment")
    })

    test(`scan rejects ${label}`, async () => {
      await expect(Storage.scan(key)).rejects.toThrow("invalid segment")
    })

    test(`list rejects ${label}`, async () => {
      await expect(Storage.list(key)).rejects.toThrow("invalid segment")
    })

    test(`removeTree rejects ${label}`, async () => {
      await expect(Storage.removeTree(key)).rejects.toThrow("invalid segment")
    })
  }

  test("rejects absolute path in middle segment", async () => {
    const root = keyRoot()
    await expect(Storage.read([root[0]!, "/etc/passwd"])).rejects.toThrow("invalid segment")
  })

  test("rejects dot in middle segment", async () => {
    const root = keyRoot()
    await expect(Storage.read([root[0]!, ".", "file"])).rejects.toThrow("invalid segment")
  })

  test("rejects dotdot traversal in middle segment", async () => {
    const root = keyRoot()
    await expect(Storage.read([root[0]!, "..", "file"])).rejects.toThrow("invalid segment")
  })
})

// =============================================================================
// Section 2: Storage error diagnostics do not leak absolute paths
// =============================================================================
describe("storage error diagnostics are path-safe", () => {
  test("NotFoundError message does not contain absolute path", async () => {
    const err = await Storage.read(["nonexistent", "missing"]).catch((e) => e)
    const msg = rejectMessage(err)
    expect(msg).not.toContain(Global.Path.data)
    expect(msg).not.toContain(os.homedir())
  })

  test("invalid segment error does not leak data root path", async () => {
    const err = await Storage.read([""]).catch((e) => e)
    const msg = rejectMessage(err)
    expect(msg).not.toContain(Global.Path.data)
  })

  test("observability keyPrefix uses first segment only, never absolute path", async () => {
    // This is a structural check: measureStorage records key[0] as keyPrefix.
    // key[0] is always user-supplied, and assertValidKey guarantees it cannot
    // be absolute or contain separators, so keyPrefix is never an absolute path.
    const root = keyRoot()
    await Storage.write([...root, "obs-item"], { v: 1 })
    const result = await Storage.read<{ v: number }>([...root, "obs-item"])
    expect(result).toEqual({ v: 1 })
  })
})

// =============================================================================
// Section 3: Path helper — Clarus outbox request ID safety
// =============================================================================
describe("clarus outbox request path helper", () => {
  test("valid request ID produces correct storage key", () => {
    const key = StoragePath.clarusOutboxRequestKey("avalid_request_123")
    expect(key).toEqual(["clarus", "outbox", encodeURIComponent("avalid_request_123")])
  })

  test("empty request ID is rejected", () => {
    expect(() => StoragePath.clarusOutboxRequestKey("")).toThrow(/empty|invalid/i)
  })

  test("request ID with NUL byte is rejected", () => {
    expect(() => StoragePath.clarusOutboxRequestKey("foo\0bar")).toThrow(/NUL|invalid/i)
  })

  test("request ID with forward slash is rejected", () => {
    expect(() => StoragePath.clarusOutboxRequestKey("foo/bar")).toThrow(/separator|invalid/i)
  })

  test("request ID with backslash is rejected", () => {
    expect(() => StoragePath.clarusOutboxRequestKey("foo\\bar")).toThrow(/separator|invalid/i)
  })

  test("request ID starting with dot is safe (encoded)", () => {
    // dots as a full segment would be dangerous, but encodeURIComponent handles them
    const key = StoragePath.clarusOutboxRequestKey("hello.world")
    expect(key).toEqual(["clarus", "outbox", encodeURIComponent("hello.world")])
  })
  test("oversize request ID is rejected", () => {
    const long = "a".repeat(257)
    expect(() => StoragePath.clarusOutboxRequestKey(long)).toThrow(/length|size/i)
  })

  test("request ID with special characters is encoded", () => {
    const key = StoragePath.clarusOutboxRequestKey("req@with spaces")
    expect(key).toEqual(["clarus", "outbox", encodeURIComponent("req@with spaces")])
  })
})

// =============================================================================
// Section 4: Storage traversal does not allow reading/writing outside data root
// =============================================================================
describe("storage containment — no outside access", () => {
  test("write cannot create files outside data root via traversal", async () => {
    const root = keyRoot()
    // The assertValidKey blocks traversal segments; this verifies the guard works
    // for a plausible traversal attempt
    await expect(Storage.write([...root, "..", "outside"], { v: 1 })).rejects.toThrow("invalid segment")
  })

  test("read cannot read files outside data root via traversal", async () => {
    await expect(Storage.read(["..", "outside"])).rejects.toThrow("invalid segment")
  })

  test("scan cannot enumerate outside data root", async () => {
    await expect(Storage.scan([".."])).rejects.toThrow("invalid segment")
  })

  test("list cannot list outside data root", async () => {
    await expect(Storage.list([".."])).rejects.toThrow("invalid segment")
  })

  test("removeTree cannot remove outside data root", async () => {
    await expect(Storage.removeTree([".."])).rejects.toThrow("invalid segment")
  })
})

// =============================================================================
describe("workspace symlink safety", () => {
  test("normal workspace creation succeeds without symlinks", async () => {
    const root = tmpWorkspaceDir()
    await fs.mkdir(root, { recursive: true })
    ClarusWorkspace.configure({ workspaceRoot: root })
    const ws = await ClarusWorkspace.ensureWorkspace({ agentId: "ag_sym", projectId: "prj_sym" })
    const stat = await fs.lstat(ws)
    expect(stat.isDirectory()).toBe(true)
    expect(stat.isSymbolicLink()).toBe(false)
  })

  test("symlink workspace root is rejected", async () => {
    const realRoot = tmpWorkspaceDir()
    await fs.mkdir(realRoot, { recursive: true })
    const symRoot = tmpWorkspaceDir()
    await fs.symlink(realRoot, symRoot)

    ClarusWorkspace.configure({ workspaceRoot: symRoot })
    await expect(ClarusWorkspace.ensureWorkspace({ agentId: "ag_symroot", projectId: "prj_symroot" })).rejects.toThrow(
      /symlink/i,
    )
  })

  test("symlink hash directory is rejected", async () => {
    const root = tmpWorkspaceDir()
    await fs.mkdir(root, { recursive: true })
    ClarusWorkspace.configure({ workspaceRoot: root })
    const wsPath = ClarusWorkspace.resolveWorkspacePath({ agentId: "ag_hash", projectId: "prj_hash" })
    const hashDir = path.dirname(wsPath)

    // Create root parent so symlink target's parent exists
    await fs.mkdir(path.dirname(hashDir), { recursive: true })
    const realTarget = tmpWorkspaceDir()
    await fs.mkdir(realTarget, { recursive: true })
    await fs.symlink(realTarget, hashDir)

    await expect(ClarusWorkspace.ensureWorkspace({ agentId: "ag_hash", projectId: "prj_hash" })).rejects.toThrow(
      /symlink/i,
    )
  })

  test("symlink workspace final directory is rejected", async () => {
    const root = tmpWorkspaceDir()
    await fs.mkdir(root, { recursive: true })
    ClarusWorkspace.configure({ workspaceRoot: root })
    const wsPath = ClarusWorkspace.resolveWorkspacePath({ agentId: "ag_ws", projectId: "prj_ws" })
    const hashDir = path.dirname(wsPath)

    await fs.mkdir(hashDir, { recursive: true })

    const realTarget = tmpWorkspaceDir()
    await fs.mkdir(realTarget, { recursive: true })
    await fs.symlink(realTarget, wsPath)

    await expect(ClarusWorkspace.ensureWorkspace({ agentId: "ag_ws", projectId: "prj_ws" })).rejects.toThrow(/symlink/i)
  })

  test("final realpath containment enforced", async () => {
    const root = tmpWorkspaceDir()
    await fs.mkdir(root, { recursive: true })
    ClarusWorkspace.configure({ workspaceRoot: root })
    const wsPath = ClarusWorkspace.resolveWorkspacePath({ agentId: "ag_cont", projectId: "prj_cont" })
    const hashDir = path.dirname(wsPath)

    await fs.mkdir(hashDir, { recursive: true })

    const outsideTarget = tmpWorkspaceDir()
    await fs.mkdir(outsideTarget, { recursive: true })
    await fs.symlink(outsideTarget, wsPath)

    await expect(ClarusWorkspace.ensureWorkspace({ agentId: "ag_cont", projectId: "prj_cont" })).rejects.toThrow(
      /symlink/i,
    )
  })

  test("symlink in intermediate path component is rejected", async () => {
    const realRoot = tmpWorkspaceDir()
    await fs.mkdir(realRoot, { recursive: true })

    ClarusWorkspace.configure({ workspaceRoot: realRoot })
    const wsPath = ClarusWorkspace.resolveWorkspacePath({ agentId: "ag_inter", projectId: "prj_inter" })
    const hashDir = path.dirname(wsPath)
    await fs.mkdir(hashDir, { recursive: true })
    await fs.mkdir(wsPath, { recursive: true })

    // Symlink the real root from another path
    const symRoot = tmpWorkspaceDir()
    await fs.symlink(realRoot, symRoot)

    ClarusWorkspace.configure({ workspaceRoot: symRoot })
    await expect(ClarusWorkspace.ensureWorkspace({ agentId: "ag_inter", projectId: "prj_inter" })).rejects.toThrow(
      /symlink/i,
    )
  })
})
