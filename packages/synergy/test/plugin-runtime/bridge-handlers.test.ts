import { describe, expect, test, beforeAll, afterAll, afterEach, mock } from "bun:test"
import { executeBridgeMethod } from "../../src/plugin-runtime/bridge-handlers.js"
import { bridgeMethodPolicy, createBridgeEnforcementHandler } from "../../src/plugin-runtime/bridge-enforcement.js"
import path from "path"
import fs from "fs/promises"
import os from "os"
import type { HostBridgeMethod } from "../../src/plugin-runtime/protocol.js"
import { Config } from "../../src/config/config.js"
import { ScopeContext } from "../../src/scope/context.js"
import type { Scope } from "../../src/scope/index.js"
import { Session } from "../../src/session/index.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string
let pluginDir: string
let workspaceDir: string
let testScope: Scope
let sessionID: string

const originalConfig = {
  domainGet: Config.domainGet,
  domainUpdate: Config.domainUpdate,
}

async function writeBaseManifest() {
  await Bun.write(
    path.join(pluginDir, "plugin.json"),
    JSON.stringify(
      {
        name: "test-plugin",
        version: "1.0.0",
        description: "Bridge test plugin",
        main: "./runtime/index.js",
        contributes: {
          tools: [
            {
              id: "tool-test",
              name: "tool-test",
              description: "Bridge test tool",
              capabilities: {
                filesystem: "write",
                shell: true,
              },
            },
          ],
        },
        permissions: {
          tools: {
            filesystem: "write",
            shell: true,
          },
          data: {
            config: "plugin",
            secrets: "own",
            session: "metadata",
            workspace: "metadata",
          },
        },
        runtime: {
          resources: {
            bridgeRequestTimeoutMs: 120_000,
          },
        },
      },
      null,
      2,
    ),
  )
}

async function writeTestFile(relativePath: string, content: string): Promise<string> {
  const fullPath = path.join(workspaceDir, relativePath)
  await fs.mkdir(path.dirname(fullPath), { recursive: true })
  await Bun.write(fullPath, content)
  return fullPath
}

function call(method: HostBridgeMethod, params: unknown = {}) {
  return ScopeContext.provide({
    scope: testScope,
    fn: () =>
      executeBridgeMethod({
        pluginId: "test-plugin",
        pluginDir,
        method,
        params,
      }),
  })
}

function contextParams(params: Record<string, unknown> = {}) {
  return {
    ...params,
    context: {
      sessionID,
      messageID: "message-test",
      agent: "synergy",
      directory: workspaceDir,
      callID: "call-test",
      toolId: "tool-test",
    },
  }
}

function callInTool(method: HostBridgeMethod, params: Record<string, unknown> = {}) {
  return call(method, contextParams(params))
}

async function callWithManifest(manifest: Record<string, unknown>, method: HostBridgeMethod, params: unknown = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-bridge-plugin-"))
  await Bun.write(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2))
  return executeBridgeMethod({
    pluginId: String(manifest.name ?? "test-plugin"),
    pluginDir: dir,
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
    workspaceDir = path.join(tmpDir, "workspace")
    testScope = {
      id: "home",
      type: "home",
      directory: workspaceDir,
      worktree: workspaceDir,
    }
    await fs.mkdir(pluginDir, { recursive: true })
    await fs.mkdir(workspaceDir, { recursive: true })
    await writeBaseManifest()
    await ScopeContext.provide({
      scope: testScope,
      fn: async () => {
        const session = await Session.create({
          id: "ses_bridge_test",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        sessionID = session.id
      },
    })
  })

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })

  afterEach(async () => {
    ;(Config as any).domainGet = originalConfig.domainGet
    ;(Config as any).domainUpdate = originalConfig.domainUpdate
    await writeBaseManifest()
  })

  // ── file.read ─────────────────────────────────────────────────
  describe("file.read", () => {
    test("returns text for a file under the tool workspace", async () => {
      await writeTestFile("hello.txt", "hello world")
      const result = await callInTool("file.read", { path: "hello.txt" })
      expect(result).toBe("hello world")
    })

    test("returns text for a nested file under the tool workspace", async () => {
      await writeTestFile("sub/deep/data.txt", "nested content")
      const result = await callInTool("file.read", { path: "sub/deep/data.txt" })
      expect(result).toBe("nested content")
    })

    test("throws when path is empty", async () => {
      await expect(callInTool("file.read", { path: "" })).rejects.toThrow(
        "file.read requires 'path' as a non-empty string",
      )
    })

    test("throws when path is missing", async () => {
      await expect(callInTool("file.read", {})).rejects.toThrow("file.read requires 'path' as a non-empty string")
    })

    test("throws on path traversal via ..", async () => {
      await expect(callInTool("file.read", { path: "../outside.txt" })).rejects.toThrow("Path traversal")
    })

    test("throws on absolute path outside workspace", async () => {
      await expect(callInTool("file.read", { path: "/etc/passwd" })).rejects.toThrow("Path traversal")
    })

    test("throws on double-encoded traversal", async () => {
      await expect(callInTool("file.read", { path: "sub/../../outside.txt" })).rejects.toThrow("Path traversal")
    })

    test("requires a tool context", async () => {
      await expect(call("file.read", { path: "hello.txt" })).rejects.toThrow("file.read requires plugin tool context")
    })
  })

  // ── file.write ────────────────────────────────────────────────
  describe("file.write", () => {
    test("writes text to a file under the tool workspace", async () => {
      await callInTool("file.write", { path: "output.txt", data: "written content" })
      const text = await Bun.file(path.join(workspaceDir, "output.txt")).text()
      expect(text).toBe("written content")
    })

    test("throws on path traversal for write", async () => {
      await expect(callInTool("file.write", { path: "../escape.txt", data: "bad" })).rejects.toThrow("Path traversal")
    })

    test("throws when data is not a string", async () => {
      await expect(callInTool("file.write", { path: "output.txt", data: 123 })).rejects.toThrow(
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

    test("throws when URL is outside manifest connectDomains", async () => {
      await expect(
        callWithManifest(
          {
            name: "network-plugin",
            version: "1.0.0",
            description: "Network plugin",
            main: "./runtime/index.js",
            permissions: {
              tools: { network: true },
              network: { connectDomains: ["api.example.com"] },
            },
          },
          "network.fetch",
          { url: "https://other.example.com/data" },
        ),
      ).rejects.toThrow("permissions.network.connectDomains")
    })
  })

  // ── workspace.getMetadata ─────────────────────────────────────
  describe("workspace.getMetadata", () => {
    test("returns basic pluginId and pluginDir", async () => {
      const result = await call("workspace.getMetadata")
      expect(result).toEqual({ pluginId: "test-plugin", pluginDir, directory: undefined })
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
  describe("context-required methods", () => {
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
    test("config.get returns the plugin namespace", async () => {
      ;(Config as any).domainGet = mock(async () => ({
        pluginConfig: {
          "test-plugin": { theme: "dark", refreshInterval: 30 },
        },
      }))

      await expect(call("config.get")).resolves.toEqual({ theme: "dark", refreshInterval: 30 })
    })

    test("config.get with key returns a single value", async () => {
      ;(Config as any).domainGet = mock(async () => ({
        pluginConfig: {
          "test-plugin": { theme: "dark" },
        },
      }))

      await expect(call("config.get", { key: "theme" })).resolves.toBe("dark")
    })

    test("config.replace replaces the namespace and validates the manifest schema", async () => {
      const domainUpdateSpy = mock(async () => {})
      ;(Config as any).domainGet = mock(async () => ({
        plugin: ["file:///plugin"],
        pluginConfig: {
          "test-plugin": { theme: "dark", oldKey: true },
        },
      }))
      ;(Config as any).domainUpdate = domainUpdateSpy

      const result = await call("config.replace", { values: { theme: "light" } })

      expect(result).toEqual({ theme: "light" })
      expect(domainUpdateSpy).toHaveBeenCalledTimes(1)
      expect((domainUpdateSpy as any).mock.calls[0]).toEqual([
        "plugins",
        {
          plugin: ["file:///plugin"],
          pluginConfig: {
            "test-plugin": { theme: "light" },
          },
        },
        { mode: "replace-domain" },
      ])
    })

    test("config.replace rejects values outside contributes.config.schema", async () => {
      await Bun.write(
        path.join(pluginDir, "plugin.json"),
        JSON.stringify(
          {
            name: "test-plugin",
            version: "1.0.0",
            description: "Bridge config schema plugin",
            main: "./runtime/index.js",
            contributes: {
              config: {
                schema: {
                  type: "object",
                  properties: { theme: { type: "string" } },
                  additionalProperties: false,
                },
              },
            },
          },
          null,
          2,
        ),
      )
      const domainUpdateSpy = mock(async () => {})
      ;(Config as any).domainGet = mock(async () => ({
        pluginConfig: {
          "test-plugin": { theme: "dark" },
        },
      }))
      ;(Config as any).domainUpdate = domainUpdateSpy

      await expect(call("config.replace", { values: { theme: "light", oldKey: true } })).rejects.toThrow(
        "contributes.config.schema",
      )
      expect(domainUpdateSpy).not.toHaveBeenCalled()
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
      const result = (await callInTool("shell.run", { cmd: "echo hello" })) as any
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("hello")
    })

    test("captures stderr on failure", async () => {
      const result = (await callInTool("shell.run", { cmd: "echo 'error message' >&2; exit 1" })) as any
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("error message")
    })

    test("requires a tool context", async () => {
      await expect(call("shell.run", { cmd: "echo hello" })).rejects.toThrow("shell.run requires plugin tool context")
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

  test("enforcer follows shared bridge policy for unprivileged and capability-gated methods", () => {
    const enforcer = createBridgeEnforcementHandler("plugin-x", [])
    expect(enforcer("cache.get", {}).allowed).toBe(true)
    expect(enforcer("permission.request", { permission: "file_read" }).allowed).toBe(false)
    expect(enforcer("tool.invoke", {}).allowed).toBe(true)
    expect(bridgeMethodPolicy("cache.get")).toEqual({ type: "unprivileged" })
    expect(bridgeMethodPolicy("permission.request")).toEqual({ type: "unprivileged" })
    expect(bridgeMethodPolicy("tool.invoke")).toEqual({ type: "unprivileged" })

    const withFileRead = createBridgeEnforcementHandler("plugin-x", ["file_read"])
    expect(withFileRead("permission.request", { permission: "file_read" }).allowed).toBe(true)
  })
})
