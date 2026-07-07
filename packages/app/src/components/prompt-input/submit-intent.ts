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
