import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { executeBridgeMethod } from "../../src/plugin-runtime/bridge-handlers.js"
import { createBridgeEnforcementHandler } from "../../src/plugin-runtime/bridge-enforcement.js"
import path from "path"
import fs from "fs/promises"
import os from "os"
import type { HostBridgeMethod } from "../../src/plugin-runtime/protocol.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string
let pluginDir: string

async function writeTestFile(relativePath: string, content: string): Promise<string> {
  const fullPath = path.join(pluginDir, relativePath)
  await fs.mkdir(path.dirname(fullPath), { recursive: true })
  await Bun.write(fullPath, content)
  return fullPath
}

function call(method: HostBridgeMethod, params: unknown = {}) {
  return executeBridgeMethod({
    pluginId: "test-plugin",
    pluginDir,
    method,
    params,
  })
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("bridge-handlers", () => {
  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-bridge-test-"))
    pluginDir = path.join(tmpDir, "plugin")
    await fs.mkdir(pluginDir, { recursive: true })
  })

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  // ── file.read ─────────────────────────────────────────────────
  describe("file.read", () => {
    test("returns text for a file under pluginDir", async () => {
      await writeTestFile("hello.txt", "hello world")
      const result = await call("file.read", { path: "hello.txt" })
      expect(result).toBe("hello world")
    })

    test("returns text for a nested file under pluginDir", async () => {
      await writeTestFile("sub/deep/data.txt", "nested content")
      const result = await call("file.read", { path: "sub/deep/data.txt" })
      expect(result).toBe("nested content")
    })

    test("throws when path is empty", async () => {
      await expect(call("file.read", { path: "" })).rejects.toThrow("file.read requires 'path' as a non-empty string")
    })

    test("throws when path is missing", async () => {
      await expect(call("file.read", {})).rejects.toThrow("file.read requires 'path' as a non-empty string")
    })

    test("throws on path traversal via ..", async () => {
      await expect(call("file.read", { path: "../outside.txt" })).rejects.toThrow("Path traversal")
    })

    test("throws on absolute path outside pluginDir", async () => {
      await expect(call("file.read", { path: "/etc/passwd" })).rejects.toThrow("Path traversal")
    })

    test("throws on double-encoded traversal", async () => {
      await expect(call("file.read", { path: "sub/../../outside.txt" })).rejects.toThrow("Path traversal")
    })
  })

  // ── file.write ────────────────────────────────────────────────
  describe("file.write", () => {
    test("writes text to a file under pluginDir", async () => {
      await call("file.write", { path: "output.txt", data: "written content" })
      const text = await Bun.file(path.join(pluginDir, "output.txt")).text()
      expect(text).toBe("written content")
    })

    test("throws on path traversal for write", async () => {
      await expect(call("file.write", { path: "../escape.txt", data: "bad" })).rejects.toThrow("Path traversal")
    })

    test("throws when data is not a string", async () => {
      await expect(call("file.write", { path: "output.txt", data: 123 })).rejects.toThrow(
        "file.write requires 'data' as a string",
      )
    })
  })

  // ── network.fetch ─────────────────────────────────────────────
  describe("network.fetch", () => {
    test("throws on empty URL", async () => {
      await expect(call("network.fetch", { url: "" })).rejects.toThrow(
        "network.fetch requires 'url' as a non-empty string",
      )
    })

    test("throws on missing URL", async () => {
      await expect(call("network.fetch", {})).rejects.toThrow("network.fetch requires 'url' as a non-empty string")
    })

    test("throws on invalid URL syntax", async () => {
      await expect(call("network.fetch", { url: "not-a-url" })).rejects.toThrow("Invalid URL")
    })

    test("throws on non-http protocol", async () => {
      await expect(call("network.fetch", { url: "ftp://localhost/file" })).rejects.toThrow(
        "Only http/https URLs are allowed",
      )
    })

    test("throws on file:// protocol", async () => {
      await expect(call("network.fetch", { url: "file:///etc/passwd" })).rejects.toThrow(
        "Only http/https URLs are allowed",
      )
    })
  })

  // ── workspace.getMetadata ─────────────────────────────────────
  describe("workspace.getMetadata", () => {
    test("returns basic pluginId and pluginDir", async () => {
      const result = await call("workspace.getMetadata")
      expect(result).toEqual({ pluginId: "test-plugin", pluginDir })
    })
  })

  // ── session.getMetadata ───────────────────────────────────────
  describe("session.getMetadata", () => {
    test("returns null", async () => {
      const result = await call("session.getMetadata")
      expect(result).toBeNull()
    })
  })

  // ── context-required methods ──────────────────────────────────
  describe("not-available methods", () => {
    test("session.read throws", async () => {
      await expect(call("session.read")).rejects.toThrow("session.read is not available in isolated runtime")
    })

    test("tool.invoke requires plugin tool context", async () => {
      await expect(call("tool.invoke")).rejects.toThrow("tool.invoke requires plugin tool context")
    })

    test("permission.request requires plugin tool context", async () => {
      await expect(call("permission.request")).rejects.toThrow("permission.request requires plugin tool context")
    })

    test("task.run requires plugin tool context", async () => {
      await expect(call("task.run")).rejects.toThrow("task.run requires plugin tool context")
    })
  })

  // ── config.get / config.set ───────────────────────────────────
  describe("config", () => {
    test("config.get returns empty by default", async () => {
      const result = await call("config.get")
      expect(result).toEqual({})
    })

    test("config.get with key returns undefined by default", async () => {
      const result = await call("config.get", { key: "nonexistent" })
      expect(result).toBeUndefined()
    })
  })

  // ── secret.get / secret.set ───────────────────────────────────
  describe("secrets", () => {
    test("secret.get returns undefined for missing key", async () => {
      const result = await call("secret.get", { key: "nonexistent" })
      expect(result).toBeUndefined()
    })

    test("secret.set and get round-trip", async () => {
      await call("secret.set", { key: "token", value: "abc123" })
      const result = await call("secret.get", { key: "token" })
      expect(result).toBe("abc123")
    })

    test("secret.delete removes a key", async () => {
      await call("secret.set", { key: "delete-me", value: "temp" })
      await call("secret.delete", { key: "delete-me" })
      const result = await call("secret.get", { key: "delete-me" })
      expect(result).toBeUndefined()
    })
  })

  // ── cache.get / cache.set ─────────────────────────────────────
  describe("cache", () => {
    test("cache.get returns undefined for missing key", async () => {
      const result = await call("cache.get", { key: "nonexistent" })
      expect(result).toBeUndefined()
    })

    test("cache.set and get round-trip", async () => {
      await call("cache.set", { key: "my-cache", value: { data: "cached" } })
      const result = await call("cache.get", { key: "my-cache" })
      expect(result).toEqual({ data: "cached" })
    })
  })

  // ── shell.run ─────────────────────────────────────────────────
  describe("shell.run", () => {
    test("runs a simple echo command and captures stdout", async () => {
      const result = (await call("shell.run", { cmd: "echo hello" })) as any
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("hello")
    })

    test("captures stderr on failure", async () => {
      const result = (await call("shell.run", { cmd: "echo 'error message' >&2; exit 1" })) as any
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("error message")
    })
  })
})

// ---------------------------------------------------------------------------
// Bridge enforcement — denied methods still throw before implementation
// ---------------------------------------------------------------------------

describe("bridge-enforcement (denied methods still throw)", () => {
  test("enforcer denies when no capabilities are approved", () => {
    const enforcer = createBridgeEnforcementHandler("plugin-x", [])
    const result = enforcer("file.read", {})
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("not approved")
  })

  test("enforcer allows when capabilities match", () => {
    const enforcer = createBridgeEnforcementHandler("plugin-x", ["file_read"])
    const result = enforcer("file.read", {})
    expect(result.allowed).toBe(true)
  })

  test("enforcer accepts Synergy capability classes as approval records", () => {
    const enforcer = createBridgeEnforcementHandler("plugin-x", ["file_read", "network_request"])
    expect(enforcer("file.read", {}).allowed).toBe(true)
    expect(enforcer("network.fetch", {}).allowed).toBe(true)
  })

  test("enforcer denies unknown bridge method", () => {
    const enforcer = createBridgeEnforcementHandler("plugin-x", ["file_read"])
    const result = enforcer("nonexistent.bridge.method" as any, {})
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("Unknown bridge method")
  })

  test("enforcer denies capability-specific methods individually", () => {
    const enforcer = createBridgeEnforcementHandler("plugin-x", ["file_read"])
    // shell.run requires shell, not granted
    const result = enforcer("shell.run", {})
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("not approved")
  })

  test("network.fetch denied when only file capabilities approved", () => {
    const enforcer = createBridgeEnforcementHandler("plugin-x", ["file_read", "file_write"])
    const result = enforcer("network.fetch", {})
    expect(result.allowed).toBe(false)
  })

  test("enforcer does not require a coarse plugin capability for cache or tool.invoke", () => {
    const enforcer = createBridgeEnforcementHandler("plugin-x", [])
    expect(enforcer("cache.get", {}).allowed).toBe(true)
    expect(enforcer("tool.invoke", {}).allowed).toBe(true)
  })
})
