import path from "path"
import fs from "fs/promises"
import type { HostBridgeMethod } from "./protocol.js"
import { createConfigAccessor, createAuthStore, createCacheStore } from "../plugin/store.js"
import {
  invokePluginTool,
  requestPluginPermission,
  runPluginTask,
  type PluginHostRuntimeContext,
} from "../plugin/host-services.js"
import { analyzeDestructiveCommand } from "../enforcement/gate.js"
import { Config } from "../config/config.js"
import * as ManifestReader from "../plugin/manifest-reader.js"
import { resolveRuntimeLimits } from "./health.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BridgeHandlerInput {
  pluginId: string
  pluginDir: string
  method: HostBridgeMethod
  params: unknown
  signal?: AbortSignal
}

// ---------------------------------------------------------------------------
// Path containment guard
// ---------------------------------------------------------------------------

function resolveContainedPath(pluginDir: string, requestedPath: string): string {
  const normalizedPluginDir = path.resolve(pluginDir)
  const resolved = path.resolve(normalizedPluginDir, requestedPath)

  if (resolved !== normalizedPluginDir && !resolved.startsWith(normalizedPluginDir + path.sep)) {
    throw new Error(`Path traversal detected: "${requestedPath}" escapes plugin directory`)
  }

  return resolved
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

export async function executeBridgeMethod(input: BridgeHandlerInput): Promise<unknown> {
  const { pluginId, pluginDir, method, params } = input
  const bridgeContext = normalizeBridgeContext(params, input.signal)

  switch (method) {
    // ── config ───────────────────────────────────────────────
    case "config.get": {
      await authorizeBridgeRequest(bridgeContext, { permission: "config:read", capability: "config:read" }, "config.get")
      try {
        const accessor = createConfigAccessor(pluginId)
        const full = await accessor.get()
        const key = (params as any)?.key
        return key !== undefined ? full[key] : full
      } catch {
        // Config inaccessible (e.g. no scope context in isolated test)
        const key = (params as any)?.key
        return key !== undefined ? undefined : {}
      }
    }
    case "config.set": {
      await authorizeBridgeRequest(bridgeContext, { permission: "config:write", capability: "config:write" }, "config.set")
      try {
        const accessor = createConfigAccessor(pluginId)
        const { key, value } = params as any
        await accessor.set({ [key]: value })
      } catch {
        // Config inaccessible — silently no-op
      }
      return undefined
    }

    // ── secrets ──────────────────────────────────────────────
    case "secret.get": {
      await authorizeBridgeRequest(bridgeContext, { permission: "secrets", capability: "secrets" }, "secret.get", {
        nonBypassable: true,
      })
      const store = createAuthStore(pluginId)
      const key = (params as any)?.key
      return typeof key === "string" ? store.get(key) : undefined
    }
    case "secret.set": {
      await authorizeBridgeRequest(bridgeContext, { permission: "secrets", capability: "secrets" }, "secret.set", {
        nonBypassable: true,
      })
      const store = createAuthStore(pluginId)
      const { key, value } = params as any
      await store.set(key, String(value))
      return undefined
    }
    case "secret.delete": {
      await authorizeBridgeRequest(bridgeContext, { permission: "secrets", capability: "secrets" }, "secret.delete", {
        nonBypassable: true,
      })
      const store = createAuthStore(pluginId)
      const key = (params as any)?.key
      if (typeof key === "string") await store.delete(key)
      return undefined
    }

    // ── cache ────────────────────────────────────────────────
    case "cache.get": {
      const store = createCacheStore(pluginId)
      const key = (params as any)?.key
      return typeof key === "string" ? store.get(key) : undefined
    }
    case "cache.set": {
      const store = createCacheStore(pluginId)
      const { key, value, ttl } = params as any
      if (typeof key !== "string") throw new Error("cache.set requires 'key' as string")
      await store.set(key, value, typeof ttl === "number" ? ttl : undefined)
      return undefined
    }
    case "cache.delete": {
      const store = createCacheStore(pluginId)
      const key = (params as any)?.key
      if (typeof key === "string") await store.delete(key)
      return undefined
    }

    // ── file ─────────────────────────────────────────────────
    case "file.read": {
      const requestedPath = (params as any)?.path
      if (typeof requestedPath !== "string" || requestedPath.trim() === "") {
        throw new Error("file.read requires 'path' as a non-empty string")
      }
      await authorizeBridgeRequest(bridgeContext, { permission: "read", capability: "file_read" }, requestedPath)
      const resolved = resolveContainedPath(pluginDir, requestedPath)
      return Bun.file(resolved).text()
    }
    case "file.write": {
      const requestedPath = (params as any)?.path
      const data = (params as any)?.data
      if (typeof requestedPath !== "string" || requestedPath.trim() === "") {
        throw new Error("file.write requires 'path' as a non-empty string")
      }
      if (typeof data !== "string") {
        throw new Error("file.write requires 'data' as a string")
      }
      await authorizeBridgeRequest(bridgeContext, { permission: "write", capability: "file_write" }, requestedPath)
      const resolved = resolveContainedPath(pluginDir, requestedPath)
      await fs.mkdir(path.dirname(resolved), { recursive: true })
      await Bun.write(resolved, data)
      return undefined
    }

    // ── network ──────────────────────────────────────────────
    case "network.fetch": {
      const urlStr = (params as any)?.url
      if (typeof urlStr !== "string" || urlStr.trim() === "") {
        throw new Error("network.fetch requires 'url' as a non-empty string")
      }
      let url: URL
      try {
        url = new URL(urlStr)
      } catch {
        throw new Error(`Invalid URL: ${urlStr}`)
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`Only http/https URLs are allowed, got: ${url.protocol}`)
      }
      await authorizeBridgeRequest(bridgeContext, { permission: "network_request", capability: "network_request" }, url.origin)

      // Build safe headers — strip Authorization
      const options = (params as any)?.options as Record<string, unknown> | undefined
      const safeHeaders = new Headers(options?.headers as HeadersInit | undefined)
      safeHeaders.delete("authorization")
      safeHeaders.delete("Authorization")

      const fetchOptions: RequestInit = {
        method: (options?.method as string) ?? "GET",
        headers: safeHeaders,
      }
      if (options?.body !== undefined) {
        fetchOptions.body = options.body as BodyInit
      }

      const res = await fetch(urlStr, fetchOptions)
      const text = await res.text()
      const responseHeaders: Record<string, string> = {}
      res.headers.forEach((v, k) => {
        responseHeaders[k] = v
      })
      return { status: res.status, headers: responseHeaders, text }
    }

    // ── shell ────────────────────────────────────────────────
    case "shell.run": {
      const cmd = (params as any)?.cmd
      if (typeof cmd !== "string" || cmd.trim() === "") {
        throw new Error("shell.run requires 'cmd' as a non-empty string")
      }
      const destructive = analyzeDestructiveCommand(cmd)
      await authorizeBridgeRequest(
        bridgeContext,
        { permission: "bash", capability: destructive.matched ? "shell_destructive" : "shell" },
        cmd,
        destructive.reason ? { reason: destructive.reason } : undefined,
      )

      const limits = await runtimeLimitsForPlugin(pluginDir)
      const requestedTimeout: number =
        typeof (params as any)?.timeout === "number" ? (params as any).timeout : limits.requestTimeoutMs
      const shellTimeout = Math.min(Math.max(requestedTimeout, 1), limits.requestTimeoutMs)

      const cwdParam = (params as any)?.cwd
      const cwd = typeof cwdParam === "string" && cwdParam ? resolveContainedPath(pluginDir, cwdParam) : pluginDir
      const proc = Bun.spawn({
        cmd: ["bash", "-c", cmd],
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      })

      const exitCode = await Promise.race([
        proc.exited,
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            proc.kill()
            reject(new Error(`Shell command timed out after ${shellTimeout}ms`))
          }, shellTimeout),
        ),
      ])

      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()

      return { exitCode, stdout, stderr }
    }

    // ── metadata ─────────────────────────────────────────────
    case "workspace.getMetadata":
      await authorizeBridgeRequest(
        bridgeContext,
        { permission: "workspace_data", capability: "workspace_data" },
        "workspace.getMetadata",
      )
      return {
        pluginId,
        pluginDir,
        directory: bridgeContext?.directory,
      }

    case "session.getMetadata":
      await authorizeBridgeRequest(
        bridgeContext,
        { permission: "session_data", capability: "session_data" },
        "session.getMetadata",
      )
      return bridgeContext
        ? {
            sessionID: bridgeContext.sessionID,
            messageID: bridgeContext.messageID,
            agent: bridgeContext.agent,
          }
        : null

    // ── not available ────────────────────────────────────────
    case "session.read":
      await authorizeBridgeRequest(bridgeContext, { permission: "session_data", capability: "session_data" }, "session.read")
      throw new Error("session.read is not available in isolated runtime")

    case "tool.invoke":
      if (!bridgeContext) throw new Error("tool.invoke requires plugin tool context")
      return invokePluginTool({
        context: bridgeContext,
        request: stripBridgeContext(params) as any,
      })

    case "permission.request":
      if (!bridgeContext) throw new Error("permission.request requires plugin tool context")
      await requestPluginPermission(bridgeContext, stripBridgeContext(params) as any)
      return { approved: true }

    case "task.run":
      if (!bridgeContext) throw new Error("task.run requires plugin tool context")
      return runPluginTask({
        pluginId,
        pluginDir,
        context: bridgeContext,
        request: stripBridgeContext(params) as any,
      })
  }
}

async function authorizeBridgeRequest(
  context: PluginHostRuntimeContext | undefined,
  request: { permission: string; capability: string },
  pattern: string,
  metadata?: Record<string, unknown>,
) {
  if (!context) return
  await requestPluginPermission(context, {
    permission: request.permission,
    patterns: [pattern || "*"],
    metadata: {
      capability: request.capability,
      source: "plugin_bridge",
      ...metadata,
    },
  })
}

function normalizeBridgeContext(params: unknown, signal?: AbortSignal): PluginHostRuntimeContext | undefined {
  const raw = (params as any)?.context
  if (!raw || typeof raw !== "object") return undefined
  if (typeof raw.sessionID !== "string" || typeof raw.messageID !== "string" || typeof raw.agent !== "string") {
    return undefined
  }
  return {
    sessionID: raw.sessionID,
    messageID: raw.messageID,
    agent: raw.agent,
    directory: typeof raw.directory === "string" ? raw.directory : undefined,
    callID: typeof raw.callID === "string" ? raw.callID : undefined,
    abort: signal,
  }
}

function stripBridgeContext(params: unknown): unknown {
  if (!params || typeof params !== "object") return params
  const { context: _context, ...rest } = params as Record<string, unknown>
  return rest
}

async function runtimeLimitsForPlugin(pluginDir: string) {
  const [config, manifest] = await Promise.all([
    Config.current().catch(() => undefined),
    ManifestReader.read(pluginDir).catch(() => undefined),
  ])
  return resolveRuntimeLimits(config?.pluginRuntimePolicy?.limits, manifest?.runtime?.resources)
}
