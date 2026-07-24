import { describe, expect, test } from "bun:test"
import {
  handoffNewSessionDraft,
  resolveVariantDisplay,
  resolveModel,
  resolveAgent,
  sessionDefaultModel,
  sessionDefaultAgent,
  sessionDefaultVariant,
  type ModelKey,
} from "../../../src/context/prompt/composer-intent"

const A: ModelKey = { providerID: "p", modelID: "a" }
const B: ModelKey = { providerID: "p", modelID: "b" }
const C: ModelKey = { providerID: "p", modelID: "c" }

const validAll = () => true
const validOnly =
  (...keys: ModelKey[]) =>
  (m: ModelKey) =>
    keys.some((k) => k.providerID === m.providerID && k.modelID === m.modelID)

describe("handoffNewSessionDraft", () => {
  test("copies explicit new-session intent to the created session", () => {
    const draft = { __new__: A, existing: B }

    expect(handoffNewSessionDraft(draft, "__new__", "created")).toEqual({
      __new__: A,
      existing: B,
      created: A,
    })
  })

  test("does not inject an effective fallback when no explicit draft exists", () => {
    const draft = { existing: B }

    expect(handoffNewSessionDraft(draft, "__new__", "created")).toBe(draft)
  })

  test("keeps the explicit model selected across the route key transition", () => {
    const draft = handoffNewSessionDraft({ __new__: A }, "__new__", "created")

    expect(resolveModel([draft.created, undefined, B], validAll)).toBe(A)
  })

  test("supports agent drafts without changing the handoff semantics", () => {
    expect(handoffNewSessionDraft({ __new__: "build" }, "__new__", "created")).toEqual({
      __new__: "build",
      created: "build",
    })
  })
})

describe("resolveModel", () => {
  test("returns the first valid candidate in priority order", () => {
    expect(resolveModel([A, B, C], validAll)).toBe(A)
  })

  test("skips undefined candidates", () => {
    expect(resolveModel([undefined, undefined, B], validAll)).toBe(B)
  })

  test("skips invalid candidates and falls through", () => {
    // draft (A) is invalid → fall to sessionDefault (B)
    expect(resolveModel([A, B, C], validOnly(B, C))).toBe(B)
  })

  test("returns undefined when nothing is valid", () => {
    expect(resolveModel([A, B], validOnly(C))).toBeUndefined()
  })

  test("#318: a valid draft is never overridden by sessionDefault/fallback", () => {
    const draft = A
    const sessionDefault = B
    const fallback = C
    expect(resolveModel([draft, sessionDefault, fallback], validAll)).toBe(A)
  })
})

describe("resolveAgent", () => {
  test("returns first selectable name", () => {
    expect(resolveAgent(["x", "y"], () => true)).toBe("x")
  })
  test("skips non-selectable", () => {
    expect(resolveAgent(["x", "y"], (n) => n === "y")).toBe("y")
  })
  test("undefined when none selectable", () => {
    expect(resolveAgent(["x"], () => false)).toBeUndefined()
  })
})

describe("sessionDefaultModel", () => {
  test("modelOverride wins over message history", () => {
    const messages = [{ role: "user", isRoot: true, model: B }]
    expect(sessionDefaultModel(A, messages)).toBe(A)
  })

  test("inherits the last root user message's model when no override", () => {
    const messages = [
      { role: "user", isRoot: true, model: A },
      { role: "assistant", model: undefined },
      { role: "user", isRoot: true, model: B },
      { role: "assistant" },
    ]
    expect(sessionDefaultModel(undefined, messages)).toBe(B)
  })

  test("ignores non-root user messages (steer/injected) when inheriting", () => {
    const messages = [
      { role: "user", isRoot: true, model: A },
      { role: "user", isRoot: false, model: C }, // steer message, not a root
    ]
    expect(sessionDefaultModel(undefined, messages)).toBe(A)
  })

  test("returns undefined when the last root has no model", () => {
    const messages = [{ role: "user", isRoot: true }]
    expect(sessionDefaultModel(undefined, messages)).toBeUndefined()
  })

  test("returns undefined for empty/missing history and no override", () => {
    expect(sessionDefaultModel(undefined, [])).toBeUndefined()
    expect(sessionDefaultModel(undefined, undefined)).toBeUndefined()
  })
})

describe("sessionDefaultAgent", () => {
  test("inherits the last root user message's agent", () => {
    const messages = [
      { role: "user", isRoot: true, agent: "build" },
      { role: "user", isRoot: true, agent: "plan" },
    ]
    expect(sessionDefaultAgent(messages)).toBe("plan")
  })

  test("undefined when no root message", () => {
    expect(sessionDefaultAgent([{ role: "assistant" }])).toBeUndefined()
  })
})

describe("sessionDefaultVariant", () => {
  test("inherits the last root user message's variant for the current model", () => {
    const messages = [
      { role: "user", isRoot: true, model: A, variant: "low" },
      { role: "user", isRoot: true, model: B, variant: "high" },
    ]
    expect(sessionDefaultVariant(B, messages)).toBe("high")
  })

  test("does not apply a history variant to a different current model", () => {
    const messages = [{ role: "user", isRoot: true, model: A, variant: "high" }]
    expect(sessionDefaultVariant(B, messages)).toBeUndefined()
  })

  test("undefined when the last root message has no variant", () => {
    expect(sessionDefaultVariant(A, [{ role: "user", isRoot: true, model: A }])).toBeUndefined()
  })
})

describe("resolveVariantDisplay", () => {
  test("prefers the explicit or historical variant", () => {
    expect(resolveVariantDisplay("low", "high", "xhigh")).toBe("low")
  })

  test("falls back to the agent default variant", () => {
    expect(resolveVariantDisplay(undefined, "high", "xhigh")).toBe("high")
  })

  test("falls back to the model role default variant", () => {
    expect(resolveVariantDisplay(undefined, undefined, "xhigh")).toBe("xhigh")
  })

  test("returns undefined when no variant is configured", () => {
    expect(resolveVariantDisplay(undefined, undefined, undefined)).toBeUndefined()
  })
})

describe("#318 end-to-end precedence", () => {
  // Simulates: user opens session B, picks model A while messages still load,
  // then history (model C) arrives. effective must stay A.
  test("draft survives a late history load", () => {
    const draft: ModelKey | undefined = A
    const messages = [{ role: "user", isRoot: true, model: C }]
    const sessionDefault = sessionDefaultModel(undefined, messages)
    const agentModel = B
    const effective = resolveModel([draft, sessionDefault, agentModel], validAll)
    expect(effective).toBe(A)
  })

  test("with no draft, history is used", () => {
    const draft: ModelKey | undefined = undefined
    const messages = [{ role: "user", isRoot: true, model: C }]
    const sessionDefault = sessionDefaultModel(undefined, messages)
    const effective = resolveModel([draft, sessionDefault, B], validAll)
    expect(effective).toBe(C)
  })

  test("variant draft survives a late history load", () => {
    const draft = "low"
    const messages = [{ role: "user", isRoot: true, model: A, variant: "high" }]
    const history = sessionDefaultVariant(A, messages)
    expect(draft ?? history).toBe("low")
  })
})
