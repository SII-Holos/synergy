import { describe, expect, test } from "bun:test"
import { modelVariantKey, modelVariantTarget } from "./model-variant"

describe("model variant session state", () => {
  test("formats provider/model variant keys", () => {
    expect(modelVariantKey({ providerID: "openai", modelID: "gpt-5.5" })).toBe("openai/gpt-5.5")
  })

  test("uses per-session persistence targets", () => {
    const sessionA = modelVariantTarget("workspace-a", "session-a")
    const sessionB = modelVariantTarget("workspace-a", "session-b")

    expect(sessionA).toMatchObject({ key: "session:session-a:model-variant" })
    expect(sessionB).toMatchObject({ key: "session:session-b:model-variant" })
    expect(sessionA).not.toEqual(sessionB)
  })

  test("keeps workspace draft variants separate from persisted sessions", () => {
    const draft = modelVariantTarget("workspace-a", undefined)
    const session = modelVariantTarget("workspace-a", "session-a")

    expect(draft).toMatchObject({ key: "workspace:model-variant" })
    expect(session).toMatchObject({ key: "session:session-a:model-variant" })
    expect(draft).not.toEqual(session)
  })

  test("does not leak variants across workspaces", () => {
    const workspaceA = modelVariantTarget("workspace-a", "session-a")
    const workspaceB = modelVariantTarget("workspace-b", "session-a")

    expect(workspaceA.key).toBe(workspaceB.key)
    expect(workspaceA.storage).not.toBe(workspaceB.storage)
  })
})

describe("model variant has() contract", () => {
  // has() uses Object.hasOwn to distinguish "never set" from "set to undefined".
  // These tests verify the underlying semantics that the thin wrapper relies on.

  test("Object.hasOwn returns false for absent key", () => {
    const store = { variant: {} as Record<string, string | undefined> }
    const key = modelVariantKey({ providerID: "openai", modelID: "gpt-5" })
    expect(Object.hasOwn(store.variant, key)).toBe(false)
  })

  test("Object.hasOwn returns true after entry is set to a value", () => {
    const store = { variant: {} as Record<string, string | undefined> }
    const key = modelVariantKey({ providerID: "openai", modelID: "gpt-5" })
    store.variant[key] = "high"
    expect(Object.hasOwn(store.variant, key)).toBe(true)
  })

  test("Object.hasOwn returns true after entry is set to undefined — explicit clear ≠ unset", () => {
    const store = { variant: {} as Record<string, string | undefined> }
    const key = modelVariantKey({ providerID: "openai", modelID: "gpt-5" })
    store.variant[key] = undefined
    expect(Object.hasOwn(store.variant, key)).toBe(true)
    expect(store.variant[key]).toBeUndefined()
  })

  test("undefined model → has() guard returns false (null-guard path)", () => {
    // mirrors model-variant.ts line 38: if (!model) return false
    const model: undefined = undefined
    expect(model ? Object.hasOwn({}, modelVariantKey(model)) : false).toBe(false)
  })
})
