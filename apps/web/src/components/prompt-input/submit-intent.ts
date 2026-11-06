export type PromptSubmitIntent = "blueprint" | "message" | "blocked"

export function resolvePromptSubmitIntent(input: {
  text: string
  working: boolean
  hasBlueprintSlot: boolean
}): PromptSubmitIntent {
  const hasText = input.text.trim().length > 0
  if (input.working && !hasText) return "blocked"
  if (input.hasBlueprintSlot) return input.working ? "blocked" : "blueprint"
  if (hasText) return "message"
  return "blocked"
}

export function canSubmitPrompt(input: { text: string; working: boolean; hasBlueprintSlot: boolean }) {
  return resolvePromptSubmitIntent(input) !== "blocked"
}

export function shouldAllowPromptSubmit(input: {
  intent: PromptSubmitIntent
  variantReady: boolean
  requiresVariant: boolean
}) {
  return input.intent !== "blocked" && (!input.requiresVariant || input.variantReady)
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
