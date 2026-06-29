import { randomUUID } from "crypto"
import type { HostBridgeMethod, HostToPlugin, PluginToHost } from "./protocol.js"
import { DEFAULT_LIMITS } from "./health.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConfigBridge {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

export interface SecretBridge {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

export interface CacheBridge {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

export interface HostBridge {
  request(method: HostBridgeMethod, params: unknown): Promise<unknown>
}

// ---------------------------------------------------------------------------
// Pending request tracking
// ---------------------------------------------------------------------------

export const REQUEST_TIMEOUT_MS = DEFAULT_LIMITS.requestTimeoutMs

type PendingEntry = {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBridgeClient(
  sendToHost: (msg: PluginToHost) => void,
  options: { requestTimeoutMs?: number } = {},
): {
  config: ConfigBridge
  secrets: SecretBridge
  cache: CacheBridge
  host: HostBridge
  request: (method: HostBridgeMethod, params: unknown) => Promise<unknown>
  handleResponse: (msg: HostToPlugin & { type: "bridgeResponse" }) => void
} {
  const pending = new Map<string, PendingEntry>()

  function handleResponse(res: HostToPlugin & { type: "bridgeResponse" }): void {
    const entry = pending.get(res.requestId)
    if (!entry) return
    pending.delete(res.requestId)
    clearTimeout(entry.timer)
    if (res.ok) {
      entry.resolve(res.value)
    } else {
      const err = new Error(res.error.message)
      err.name = res.error.name
      if (res.error.stack) err.stack = res.error.stack
      entry.reject(err)
    }
  }

  function request(method: HostBridgeMethod, params: unknown): Promise<unknown> {
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error(`host bridge request timed out: ${method}`))
      }, options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS)

      pending.set(requestId, { resolve, reject, timer })
      sendToHost({ type: "hostRequest", requestId, method, params })
    })
  }

  const config: ConfigBridge = {
    get(key: string): Promise<unknown> {
      return request("config.get", { key })
    },
    set(key: string, value: unknown): Promise<void> {
      return request("config.set", { key, value }) as Promise<void>
    },
  }

  const secrets: SecretBridge = {
    get(key: string): Promise<string | undefined> {
      return request("secret.get", { key }) as Promise<string | undefined>
    },
    set(key: string, value: string): Promise<void> {
      return request("secret.set", { key, value }) as Promise<void>
    },
    delete(key: string): Promise<void> {
      return request("secret.delete", { key }) as Promise<void>
    },
  }

  const cache: CacheBridge = {
    get(key: string): Promise<unknown> {
      return request("cache.get", { key })
    },
    set(key: string, value: unknown): Promise<void> {
      return request("cache.set", { key, value }) as Promise<void>
    },
  }

  const host: HostBridge = {
    request(method: HostBridgeMethod, params: unknown): Promise<unknown> {
      return request(method, params)
    },
  }

  return { config, secrets, cache, host, request, handleResponse }
}
