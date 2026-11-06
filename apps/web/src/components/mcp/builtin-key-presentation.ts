import type { BuiltinMcpDraft } from "@/components/settings/types"
import type { McpStatusTone } from "@/components/mcp/status-presentation"

export type BuiltinKeyChip = {
  label: string
  tone: McpStatusTone
}

/** Descriptor-shaped translate; callers pass their own `_` from useLingui. */
export type BuiltinKeyTranslate = (descriptor: { id: string; message: string }) => string

export const apiKeyClearPending = {
  id: "settings.mcp.builtins.apiKey.clearPending",
  message: "Key will be removed on save",
}
export const apiKeyUnset = { id: "settings.mcp.builtins.apiKey.unset", message: "No key set" }
export const apiKeySaved = { id: "settings.mcp.builtins.apiKey.saved", message: "Key saved" }
export const apiKeyPending = { id: "settings.mcp.builtins.apiKey.pending", message: "Not saved yet" }

/**
 * State chip for a built-in API key field. The save path resets the draft to
 * an empty string, so without an explicit saved/unsaved distinction the field
 * looks identical before and after a successful save — the whole complaint the
 * chip exists to answer. Order matters: a pending clear outranks a fresh draft
 * because saving would remove the key, not store one.
 */
export function builtinKeyChip(builtin: BuiltinMcpDraft, _: BuiltinKeyTranslate): BuiltinKeyChip {
  if (builtin.clearApiKey && builtin.keyConfigured) {
    return { label: _(apiKeyClearPending), tone: "danger" }
  }
  if (builtin.apiKeyDraft.trim() !== "") return { label: _(apiKeyPending), tone: "warning" }
  if (builtin.keyConfigured) {
    const hint = builtin.keyHint ? ` ${builtin.keyHint}` : ""
    return { label: `${_(apiKeySaved)}${hint}`, tone: "success" }
  }
  return { label: _(apiKeyUnset), tone: "neutral" }
}
