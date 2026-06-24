import path from "path"
import fs from "fs/promises"
import type { HostBridgeMethod } from "./protocol.js"
import { createConfigAccessor, createAuthStore, createCacheStore } from "../plugin/store.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BridgeHandlerInput {
  pluginId: string
  pluginDir: string
  method: HostBridgeMethod
  params: unknown
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

  switch (method) {
    // ── config ───────────────────────────────────────────────
    case "config.get": {
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
      const store = createAuthStore(pluginId)
      const key = (params as any)?.key
      return typeof key === "string" ? store.get(key) : undefined
    }
    case "secret.set": {
      const store = createAuthStore(pluginId)
      const { key, value } = params as any
      await store.set(key, String(value))
      return undefined
    }
    case "secret.delete": {
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

      const requestedTimeout: number = typeof (params as any)?.timeout === "number" ? (params as any).timeout : 30_000
      const shellTimeout = Math.min(Math.max(requestedTimeout, 1), 60_000)

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
      return {
        pluginId,
        pluginDir,
      }

    case "session.getMetadata":
      return null

    // ── not available ────────────────────────────────────────
    case "session.read":
      throw new Error("session.read is not available in isolated runtime")

    case "tool.invoke":
      throw new Error("tool.invoke is not available in MVP")

    case "permission.request":
      return {
        approved: false,
        reason: "interactive permission requests are not available in isolated runtime MVP",
      }
  }
}
