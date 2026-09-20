export type PromptSubmitIntent = "abort" | "blueprint" | "message" | "blocked"

export function resolvePromptSubmitIntent(input: {
  text: string
  working: boolean
  hasBlueprintSlot: boolean
}): PromptSubmitIntent {
  const hasText = input.text.trim().length > 0
  if (input.working && !hasText) return "abort"
  if (input.hasBlueprintSlot) return "blueprint"
  if (hasText) return "message"
  return "blocked"
}

export function canSubmitPrompt(input: { text: string; working: boolean; hasBlueprintSlot: boolean }) {
  return resolvePromptSubmitIntent(input) !== "blocked"
}

/** Sending must wait for every composer attachment upload to settle. Stopping
 *  the session stays available because it sends nothing. */
export function shouldBlockSubmitForUploadingAttachments(input: { uploading: boolean; intent: PromptSubmitIntent }) {
  return input.uploading && input.intent !== "abort"
}

export function shouldAllowPromptSubmit(input: {
  intent: PromptSubmitIntent
  variantReady: boolean
  requiresVariant: boolean
}) {
  if (input.intent === "abort") return true
  return !input.requiresVariant || input.variantReady
}

export function shouldRunComposerBeforeSubmit(input: {
  intent: PromptSubmitIntent
  mode: "normal" | "shell"
  slashKind: "none" | "backend-prompt" | "backend-action" | "ui"
  hasBlueprintSlot: boolean
  pendingLightLoop: boolean
}) {
  return (
    input.intent === "message" &&
    input.mode === "normal" &&
    input.slashKind === "none" &&
    !input.hasBlueprintSlot &&
    !input.pendingLightLoop
  )
}
