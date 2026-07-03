import path from "path"
import fs from "fs/promises"
import type { HostBridgeMethod } from "./protocol.js"
import { createAuthStore, createCacheStore } from "../plugin/store.js"
import { getPluginConfig, replacePluginConfig, setPluginConfigKey } from "../plugin/config-store.js"
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
import { isPathContained } from "../util/path-contain.js"

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

function requireToolContext(context: PluginHostRuntimeContext | undefined, method: string): PluginHostRuntimeContext {
  if (!context) throw new Error(`${method} requires plugin tool context`)
  return context
}

function resolveWorkspacePath(context: PluginHostRuntimeContext, requestedPath: string): string {
  const workspace = context.directory
  if (!workspace) throw new Error("Plugin tool context is missing a workspace directory")
  const normalizedWorkspace = path.resolve(workspace)
  const resolved = path.resolve(normalizedWorkspace, requestedPath)

  if (!isPathContained(normalizedWorkspace, resolved)) {
    throw new Error(`Path traversal detected: "${requestedPath}" escapes workspace directory`)
  }

  return resolved
}

async function assertWorkspaceRealpath(
  context: PluginHostRuntimeContext,
  resolvedPath: string,
  requestedPath: string,
): Promise<void> {
  const workspace = context.directory
  if (!workspace) throw new Error("Plugin tool context is missing a workspace directory")
  const realWorkspace = await fs.realpath(path.resolve(workspace)).catch(() => path.resolve(workspace))
  let current = resolvedPath

  while (true) {
    const real = await fs.realpath(current).catch(() => undefined)
    if (real) {
      if (!isPathContained(realWorkspace, real)) {
        throw new Error(`Path traversal detected: "${requestedPath}" escapes workspace directory`)
      }
      return
    }
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

export async function executeBridgeMethod(input: BridgeHandlerInput): Promise<unknown> {
  const { pluginId, pluginDir, method, params } = input
  const bridgeContext = normalizeBridgeContext(params, input.signal, { pluginId, pluginDir })

  switch (method) {
    // ── config ───────────────────────────────────────────────
    case "config.get": {
      await authorizeBridgeCapability(bridgeContext, "config:read", "config.get")
      const full = await getPluginConfig(pluginId)
      const key = (params as any)?.key
      return key !== undefined ? full[key] : full
    }
    case "config.set": {
      await authorizeBridgeCapability(bridgeContext, "config:write", "config.set")
      const { key, value } = params as any
      if (typeof key !== "string" || key.trim() === "") {
        throw new Error("config.set requires 'key' as a non-empty string")
      }
      const manifest = await ManifestReader.read(pluginDir)
      return await setPluginConfigKey(pluginId, key, value, { manifest })
    }
    case "config.replace": {
      await authorizeBridgeCapability(bridgeContext, "config:write", "config.replace")
      const values = (params as any)?.values
      const manifest = await ManifestReader.read(pluginDir)
      return await replacePluginConfig(pluginId, values, { manifest })
    }

    // ── secrets ──────────────────────────────────────────────
    case "secret.get": {
      await authorizeBridgeCapability(bridgeContext, "secrets", "secret.get", {
        nonBypassable: true,
      })
      const store = createAuthStore(pluginId)
      const key = (params as any)?.key
      return typeof key === "string" ? store.get(key) : undefined
    }
    case "secret.set": {
      await authorizeBridgeCapability(bridgeContext, "secrets", "secret.set", {
        nonBypassable: true,
      })
      const store = createAuthStore(pluginId)
      const { key, value } = params as any
      await store.set(key, String(value))
      return undefined
    }
    case "secret.delete": {
      await authorizeBridgeCapability(bridgeContext, "secrets", "secret.delete", {
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
      const context = requireToolContext(bridgeContext, "file.read")
      const resolved = resolveWorkspacePath(context, requestedPath)
      await assertWorkspaceRealpath(context, resolved, requestedPath)
      await authorizeBridgeCapability(context, "file_read", requestedPath)
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
      const context = requireToolContext(bridgeContext, "file.write")
      const resolved = resolveWorkspacePath(context, requestedPath)
      await assertWorkspaceRealpath(context, resolved, requestedPath)
      await authorizeBridgeCapability(context, "file_write", requestedPath)
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
      await assertNetworkDomainAllowed(pluginDir, url)
      await authorizeBridgeCapability(bridgeContext, "network_request", url.origin)

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
      const context = requireToolContext(bridgeContext, "shell.run")
      const cwdParam = (params as any)?.cwd
      let cwd = context.directory
      if (!cwd) throw new Error("Plugin tool context is missing a workspace directory")
      if (typeof cwdParam === "string" && cwdParam) {
        cwd = resolveWorkspacePath(context, cwdParam)
        await assertWorkspaceRealpath(context, cwd, cwdParam)
      }
      const destructive = analyzeDestructiveCommand(cmd)
      await authorizeBridgeCapability(
        context,
        destructive.matched ? "shell_destructive" : "shell",
        cmd,
        destructive.reason ? { reason: destructive.reason } : undefined,
      )

      const limits = await runtimeLimitsForPlugin(pluginDir)
      const requestedTimeout: number =
        typeof (params as any)?.timeout === "number" ? (params as any).timeout : limits.bridgeRequestTimeoutMs
      const shellTimeout = Math.min(Math.max(requestedTimeout, 1), limits.bridgeRequestTimeoutMs)

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
      await authorizeBridgeCapability(bridgeContext, "workspace_data", "workspace.getMetadata")
      return {
        pluginId,
        pluginDir,
        directory: bridgeContext?.directory,
      }

    case "session.getMetadata":
      await authorizeBridgeCapability(bridgeContext, "session_data", "session.getMetadata")
      return bridgeContext
        ? {
            sessionID: bridgeContext.sessionID,
            messageID: bridgeContext.messageID,
            agent: bridgeContext.agent,
          }
        : null

    case "tool.invoke":
      if (!bridgeContext) throw new Error("tool.invoke requires plugin tool context")
      return invokePluginTool({
        context: bridgeContext,
        pluginDir,
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

async function authorizeBridgeCapability(
  context: PluginHostRuntimeContext | undefined,
  capability: string,
  pattern: string,
  metadata?: Record<string, unknown>,
) {
  if (!context) return
  await requestPluginPermission(context, {
    permission: capability,
    patterns: [pattern || "*"],
    metadata: {
      capability,
      source: "plugin_bridge",
      ...metadata,
    },
  })
}

function normalizeBridgeContext(
  params: unknown,
  signal: AbortSignal | undefined,
  plugin: { pluginId: string; pluginDir: string },
): PluginHostRuntimeContext | undefined {
  const raw = (params as any)?.context
  if (!raw || typeof raw !== "object") return undefined
  if (typeof raw.sessionID !== "string" || typeof raw.messageID !== "string" || typeof raw.agent !== "string") {
    return undefined
  }
  return {
    pluginId: plugin.pluginId,
    pluginDir: plugin.pluginDir,
    toolId: typeof raw.toolId === "string" ? raw.toolId : undefined,
    sessionID: raw.sessionID,
    messageID: raw.messageID,
    agent: raw.agent,
    directory: typeof raw.directory === "string" ? raw.directory : undefined,
    callID: typeof raw.callID === "string" ? raw.callID : undefined,
    abort: signal,
  }
}

async function assertNetworkDomainAllowed(pluginDir: string, url: URL) {
  const manifest = await ManifestReader.read(pluginDir)
  const domains = manifest.permissions?.network?.connectDomains ?? []
  if (domains.length === 0 || domains.includes("*")) return
  if (domains.some((domain) => domainMatchesUrl(domain, url))) return
  throw new Error(`network.fetch URL "${url.origin}" is not allowed by permissions.network.connectDomains`)
}

function domainMatchesUrl(pattern: string, url: URL): boolean {
  const normalized = pattern.trim().toLowerCase()
  if (!normalized) return false
  if (normalized === "*") return true

  if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
    try {
      return new URL(normalized).origin === url.origin.toLowerCase()
    } catch {
      return false
    }
  }

  const hostPattern = normalized.replace(/\/.*$/, "")
  const targetHost = url.hostname.toLowerCase()
  const targetHostPort = url.host.toLowerCase()
  if (hostPattern.startsWith("*.")) {
    const suffix = hostPattern.slice(1)
    return targetHost.endsWith(suffix) && targetHost !== suffix.slice(1)
  }
  return hostPattern === targetHost || hostPattern === targetHostPort
}

function stripBridgeContext(params: unknown): unknown {
  if (!params || typeof params !== "object") return params
  const { context: _context, ...rest } = params as Record<string, unknown>
  return rest
}

async function runtimeLimitsForPlugin(pluginDir: string) {
  const [config, manifest] = await Promise.all([
    Config.current().catch(() => undefined),
    ManifestReader.read(pluginDir),
  ])
  return resolveRuntimeLimits(config?.pluginRuntimePolicy?.limits, manifest?.runtime?.resources)
}
