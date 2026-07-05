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
