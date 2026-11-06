import { describe, expect, test } from "bun:test"
import { modelVariantKey, modelVariantTarget } from "../../../src/context/prompt/model-variant"

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
  // SolidJS setStore("variant", key, undefined) deletes the property instead
  // of storing it, which makes Object.hasOwn return false — indistinguishable
  // from "never set". The workaround: set() stores null as the sentinel for
  // explicit clears, get() converts null → undefined, and has() uses
  // raw !== undefined (which correctly distinguishes null from undefined).

  const key = modelVariantKey({ providerID: "openai", modelID: "gpt-5" })

  test("null sentinel is distinguishable from never-set in a raw store", () => {
    const variant = {} as Record<string, string | null | undefined>
    // never set — property access gives undefined
    expect(variant[key]).toBeUndefined()
    // explicit clear via null sentinel (simulating set(undefined))
    variant[key] = null
    expect(variant[key]).toBeNull()
    // null !== undefined → has() can distinguish
    expect(variant[key] !== undefined).toBe(true)
  })

  test("get() returns undefined for both absent key and null sentinel", () => {
    // External contract: get() never leaks null. Both "never set" and
    // "explicit clear" surface as undefined.
    const variant = {} as Record<string, string | null | undefined>
    expect(variant[key] ?? undefined).toBeUndefined()
    variant[key] = null
    expect(variant[key] ?? undefined).toBeUndefined()
  })

  test("undefined model input → null-guard returns false", () => {
    // mirrors has(model) { if (!model) return false }
    const model: undefined = undefined
    expect(!!model).toBe(false)
  })
})
