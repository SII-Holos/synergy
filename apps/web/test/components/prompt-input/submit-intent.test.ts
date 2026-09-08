import { describe, expect, test } from "bun:test"
import {
  canSubmitPrompt,
  resolvePromptSubmitIntent,
  shouldAllowPromptSubmit,
  shouldRunComposerBeforeSubmit,
} from "../../../src/components/prompt-input/submit-intent"

describe("prompt submit intent", () => {
  test("blocks ordinary empty and attachment-only messages", () => {
    expect(resolvePromptSubmitIntent({ text: "", working: false, hasBlueprintSlot: false })).toBe("blocked")
    expect(canSubmitPrompt({ text: "  ", working: false, hasBlueprintSlot: false })).toBe(false)
  })

  test("allows non-empty ordinary messages", () => {
    expect(resolvePromptSubmitIntent({ text: "Do the work", working: false, hasBlueprintSlot: false })).toBe("message")
  })

  test("allows empty Blueprint starts", () => {
    expect(resolvePromptSubmitIntent({ text: "", working: false, hasBlueprintSlot: true })).toBe("blueprint")
  })

  test("treats empty submit while running as abort", () => {
    expect(resolvePromptSubmitIntent({ text: "", working: true, hasBlueprintSlot: false })).toBe("abort")
  })
})

describe("prompt submit readiness", () => {
  test("blocks variant-dependent submits while intent is unresolved", () => {
    expect(shouldAllowPromptSubmit({ intent: "message", variantReady: false, requiresVariant: true })).toBe(false)
  })

  test("keeps variant-independent submits available while intent is unresolved", () => {
    expect(shouldAllowPromptSubmit({ intent: "abort", variantReady: false, requiresVariant: true })).toBe(true)
    expect(shouldAllowPromptSubmit({ intent: "message", variantReady: false, requiresVariant: false })).toBe(true)
    expect(shouldAllowPromptSubmit({ intent: "blueprint", variantReady: false, requiresVariant: false })).toBe(true)
  })

  test("allows variant-dependent submits after intent resolves", () => {
    expect(shouldAllowPromptSubmit({ intent: "message", variantReady: true, requiresVariant: true })).toBe(true)
  })
})

describe("shouldRunComposerBeforeSubmit", () => {
  const ordinary = {
    intent: "message" as const,
    mode: "normal" as const,
    slashKind: "none" as const,
    hasBlueprintSlot: false,
    pendingLightLoop: false,
  }

  test("includes ordinary and queued messages", () => {
    expect(shouldRunComposerBeforeSubmit(ordinary)).toBe(true)
  })

  test("excludes shell, commands, empty/abort, Blueprint, and Light Loop starts", () => {
    expect(shouldRunComposerBeforeSubmit({ ...ordinary, mode: "shell" })).toBe(false)
    expect(shouldRunComposerBeforeSubmit({ ...ordinary, slashKind: "backend-action" })).toBe(false)
    expect(shouldRunComposerBeforeSubmit({ ...ordinary, intent: "blocked" })).toBe(false)
    expect(shouldRunComposerBeforeSubmit({ ...ordinary, intent: "abort" })).toBe(false)
    expect(shouldRunComposerBeforeSubmit({ ...ordinary, hasBlueprintSlot: true })).toBe(false)
    expect(shouldRunComposerBeforeSubmit({ ...ordinary, pendingLightLoop: true })).toBe(false)
  })
})
