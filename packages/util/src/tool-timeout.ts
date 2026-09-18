/**
 * The single definition of the tool-timeout contract shared by the runtime
 * (which produces it on tool parts) and the shared UI (which renders it).
 *
 * It lives in `util` because that is the only workspace package both
 * `harness` and `ui` already depend on; UI may not import runtime-private
 * modules, and exposing this through the plugin API would turn an internal
 * diagnostic bag into a versioned public contract.
 *
 * Field names and units are deliberately unchanged (`*Ms`): the metadata is
 * persisted on tool parts, so renaming would strand the timeout information on
 * every historical part. Seconds are the unit at the human- and agent-facing
 * boundary only; the conversion happens there, not here.
 */
export type ToolTimeoutSource =
  | "tool_timeout"
  | "search"
  | "fetch"
  | "download"
  | "wait"
  | "auto_background"
  | "question"
  | "vision"
  | "remote_connect"
  | "document_extract"

export interface ToolTimeoutMetadata {
  toolTimeoutMs: number
  operationTimeoutMs?: number
  displayMs: number
  source: ToolTimeoutSource
}
