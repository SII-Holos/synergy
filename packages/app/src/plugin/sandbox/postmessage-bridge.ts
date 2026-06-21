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
