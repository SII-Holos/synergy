import { describe, expect, test } from "bun:test"
import { builtinKeyChip, type BuiltinKeyTranslate } from "../../../src/components/mcp/builtin-key-presentation"
import type { BuiltinMcpDraft } from "../../../src/components/settings/types"

// Identity translate so the assertion is about which descriptor was selected.
const identity: BuiltinKeyTranslate = (descriptor) => descriptor.id

const base: Omit<BuiltinMcpDraft, "keyConfigured"> = {
  name: "anysearch",
  url: "https://api.anysearch.com/mcp",
  status: { status: "connected" },
  toggle: true,
  apiKeyDraft: "",
  clearApiKey: false,
}

const draft = (overrides: Partial<BuiltinMcpDraft>) =>
  ({ ...base, keyConfigured: false, ...overrides }) as BuiltinMcpDraft

describe("builtinKeyChip", () => {
  test("reads as unset when no key is stored and no draft exists", () => {
    expect(builtinKeyChip(draft({}), identity)).toEqual({
      label: "settings.mcp.builtins.apiKey.unset",
      tone: "neutral",
    })
  })

  test("reads as saved with the masked hint when a key is stored", () => {
    expect(builtinKeyChip(draft({ keyConfigured: true, keyHint: "••••9876" }), identity)).toEqual({
      label: "settings.mcp.builtins.apiKey.saved ••••9876",
      tone: "success",
    })
  })

  test("reads as saved without a hint suffix when the server sends none", () => {
    expect(builtinKeyChip(draft({ keyConfigured: true }), identity)).toEqual({
      label: "settings.mcp.builtins.apiKey.saved",
      tone: "success",
    })
  })

  // The regression this helper exists for: the save path resets the draft, so a
  // typed-but-unsaved key must not read like a stored one.
  test("reads as pending while a replacement draft is unsaved", () => {
    const chip = builtinKeyChip(draft({ keyConfigured: true, apiKeyDraft: "as_sk_new", keyHint: "••••9876" }), identity)
    expect(chip).toEqual({ label: "settings.mcp.builtins.apiKey.pending", tone: "warning" })
  })

  test("treats a whitespace-only draft as no draft", () => {
    expect(builtinKeyChip(draft({ keyConfigured: true, apiKeyDraft: "   " }), identity).tone).toBe("success")
  })

  test("a pending clear outranks a stored key", () => {
    expect(builtinKeyChip(draft({ keyConfigured: true, clearApiKey: true, keyHint: "••••9876" }), identity)).toEqual({
      label: "settings.mcp.builtins.apiKey.clearPending",
      tone: "danger",
    })
  })

  test("a pending clear outranks an unsaved replacement draft, matching what saving would do", () => {
    const chip = builtinKeyChip(draft({ keyConfigured: true, clearApiKey: true, apiKeyDraft: "as_sk_new" }), identity)
    expect(chip.tone).toBe("danger")
  })

  test("an unset key clears the pending state so no phantom 'will be removed' is shown", () => {
    expect(builtinKeyChip(draft({ clearApiKey: true }), identity).tone).toBe("neutral")
  })

  test("every state is visually distinguished", () => {
    const tones = [
      builtinKeyChip(draft({}), identity).tone,
      builtinKeyChip(draft({ keyConfigured: true }), identity).tone,
      builtinKeyChip(draft({ keyConfigured: true, apiKeyDraft: "x" }), identity).tone,
      builtinKeyChip(draft({ keyConfigured: true, clearApiKey: true }), identity).tone,
    ]
    expect(new Set(tones).size).toBe(4)
  })
})
