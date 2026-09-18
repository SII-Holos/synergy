import type { Part } from "@ericsanchezok/synergy-sdk/client"

// A queued streaming checkpoint can trail deltas already applied locally.
// No-delta writes are authoritative, including intentional prefix truncation.
export function mergeTextCheckpoint(current: Part, incoming: Part, streaming = false): Part {
  if (!streaming || (incoming.type !== "text" && incoming.type !== "reasoning")) return incoming
  if ((current.type !== "text" && current.type !== "reasoning") || current.type !== incoming.type) return incoming
  if (incoming.text.length >= current.text.length || !current.text.startsWith(incoming.text)) return incoming
  return { ...incoming, text: current.text }
}
