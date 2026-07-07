import { describe, expect, test } from "bun:test"
import { canSubmitPrompt, resolvePromptSubmitIntent } from "./submit-intent"

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
