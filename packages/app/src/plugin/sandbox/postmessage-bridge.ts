/** Typed bridge protocol between host and sandboxed plugin iframes */

export type BridgeMessage =
  | { type: "plugin.ready" }
  | { type: "plugin.init"; payload: { config: Record<string, unknown>; theme: string } }
  | { type: "plugin.action"; id: string; payload: unknown }
  | { type: "host.action"; id: string; payload: unknown }
  | { type: "plugin.resize"; payload: { width: number; height: number } }
  | { type: "plugin.toast"; payload: { message: string; variant?: string } }
  | { type: "plugin.error"; payload: { message: string; code?: string } }

export function parseBridgeMessage(data: unknown): BridgeMessage | null {
  if (typeof data !== "object" || data === null) return null
  const msg = data as Record<string, unknown>
  if (typeof msg.type !== "string") return null
  const validTypes = new Set([
    "plugin.ready",
    "plugin.init",
    "plugin.action",
    "host.action",
    "plugin.resize",
    "plugin.toast",
    "plugin.error",
  ])
  if (!validTypes.has(msg.type)) return null
  return data as BridgeMessage
}
export function isValidOrigin(origin: string, hostOrigin: string): boolean {
  // Sandboxed iframes (without allow-same-origin) get an opaque origin serialized as "null"
  return origin === hostOrigin || origin === "null"
}

// ── Rich Sandbox Protocol ────────────────────────────────────────────────────

/** Messages sent from the sandboxed plugin iframe to the host. */
export type SandboxMessage =
  | { type: "ready" }
  | { type: "getConfig"; requestId: string }
  | { type: "setConfig"; requestId: string; values: Record<string, any> }
  | { type: "getScopeMetadata"; requestId: string }
  | { type: "toast"; message: string; variant?: string }
  | { type: "navigate"; to: string }
  | { type: "requestPermission"; requestId: string; permission: string; patterns: string[] }

/** Responses the host sends back to the sandboxed iframe. */
export type SandboxResponse =
  | { type: "config"; requestId: string; values: Record<string, any> }
  | { type: "scopeMetadata"; requestId: string; metadata: Record<string, any> }
  | { type: "permissionResult"; requestId: string; granted: boolean; reason?: string }
  | { type: "error"; requestId: string; message: string; code?: string }

/** Known sandbox message type strings for validation. */
const SANDBOX_MESSAGE_TYPES = new Set([
  "ready",
  "getConfig",
  "setConfig",
  "getScopeMetadata",
  "toast",
  "navigate",
  "requestPermission",
])

/**
 * Loose validation: check that a postMessage payload conforms to the
 * SandboxMessage union shape. Only the type field is strictly validated;
 * per-message field validation happens in the handlers.
 */
export function parseSandboxMessage(data: unknown): SandboxMessage | null {
  if (typeof data !== "object" || data === null) return null
  const msg = data as Record<string, unknown>
  if (typeof msg.type !== "string") return null
  if (!SANDBOX_MESSAGE_TYPES.has(msg.type)) return null
  return data as SandboxMessage
}

// ── Timeout ───────────────────────────────────────────────────────────────────

export const DEFAULT_SANDBOX_TIMEOUT_MS = 10_000

/** Wrap a promise with a timeout. Rejects after `ms` milliseconds. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label?: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(label ? `Timeout: ${label}` : "Timeout")), ms)),
  ])
}
