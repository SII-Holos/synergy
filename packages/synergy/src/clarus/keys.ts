/** Maximum length for a single Clarus identity segment (agentId, projectId, taskId, messageId). */
export const MAX_SEGMENT_LENGTH = 512

export const MAX_REQUEST_ID_LENGTH = 128

export function validateRequestID(requestID: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestID)) {
    throw new Error("Clarus requestID contains invalid characters or exceeds its limit")
  }
  return requestID
}
import { canonicalHash } from "@/util/canonical"
export function encodeSegment(s: string): string {
  if (s.length > MAX_SEGMENT_LENGTH) {
    throw new Error(`Clarus segment exceeds max length ${MAX_SEGMENT_LENGTH}: ${s.slice(0, 128)}...`)
  }
  return encodeURIComponent(s)
}

/** Validate a segment without encoding. Returns the segment or throws. */
export function validateSegment(s: string): string {
  if (s.length === 0) throw new Error("Clarus identity segment must not be empty")
  if (s.length > MAX_SEGMENT_LENGTH) {
    throw new Error(`Clarus segment exceeds max length ${MAX_SEGMENT_LENGTH}: ${s.slice(0, 128)}...`)
  }
  return s
}

/** Build a collision-safe binding storage key from encoded segments. */
export function bindingKey(agentId: string, projectId: string): string {
  return `${encodeSegment(agentId)}:${encodeSegment(projectId)}`
}

/** Build a collision-safe message dedup storage key from encoded segments. */
export function dedupMessageKey(agentId: string, projectId: string, messageId: string): string {
  return `${encodeSegment(agentId)}:${encodeSegment(projectId)}:${encodeSegment(messageId)}`
}

/** Build a collision-safe task-message dedup key that includes taskId for cross-task isolation. */
export function dedupTaskMessageKey(agentId: string, projectId: string, taskId: string, messageId: string): string {
  return `${encodeSegment(agentId)}:${encodeSegment(projectId)}:${encodeSegment(taskId)}:${encodeSegment(messageId)}`
}

/** Build a namespaced Lock key for Clarus operations. */
export function lockKey(ns: string, agentId: string, projectId: string, extra?: string): string {
  const base = `clarus:${ns}:${encodeSegment(agentId)}:${encodeSegment(projectId)}`
  return extra ? `${base}:${encodeSegment(extra)}` : base
}

/** Derive deterministic inbox/message IDs from the collision-safe assignment identity (agentId, projectId, taskId).
 *  Uses SHA-256 hashing so the IDs never collide across different tuple boundaries. */
export function deriveAssignmentIDs(
  agentId: string,
  projectId: string,
  taskId: string,
): {
  itemID: string
  messageID: string
} {
  const input = `${encodeSegment(agentId)}:${encodeSegment(projectId)}:${encodeSegment(taskId)}`
  const hash = new Bun.CryptoHasher("sha256").update(input).digest("base64url").slice(0, 32)
  return {
    itemID: `inb_clarus_${hash}`,
    messageID: `msg_clarus_${hash}`,
  }
}

/** Compute a canonical SHA-256 payload hash for a plain object using recursive canonical serialization. */
export function payloadHash(payload: Record<string, unknown>): string {
  return canonicalHash(payload)
}
