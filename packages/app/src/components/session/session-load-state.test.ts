import { describe, expect, test } from "bun:test"
import { sessionLoadView } from "./session-load-state"

const idle = { phase: "idle" as const, generation: 0, hasSnapshot: false }

describe("session load presentation", () => {
  test("distinguishes initial loading, delayed recovery, and initial error", () => {
    expect(
      sessionLoadView({
        hasRenderableContent: false,
        messages: undefined,
        load: { phase: "loading", generation: 1, hasSnapshot: false },
        delayed: false,
      }),
    ).toEqual({ type: "loading" })

    expect(
      sessionLoadView({
        hasRenderableContent: false,
        messages: undefined,
        load: { phase: "loading", generation: 1, hasSnapshot: false },
        delayed: true,
      }),
    ).toEqual({ type: "delayed-loading" })

    expect(
      sessionLoadView({
        hasRenderableContent: false,
        messages: undefined,
        load: { phase: "error", generation: 1, hasSnapshot: false, error: "Offline" },
        delayed: false,
      }),
    ).toEqual({ type: "initial-error", error: "Offline" })
  })

  test("keeps loaded-empty visible through refresh and refresh failure", () => {
    expect(
      sessionLoadView({ hasRenderableContent: false, messages: [], load: { ...idle, phase: "ready" }, delayed: false }),
    ).toEqual({ type: "empty" })

    expect(
      sessionLoadView({
        hasRenderableContent: false,
        messages: [],
        load: { phase: "refreshing", generation: 2, hasSnapshot: true },
        delayed: false,
      }),
    ).toEqual({ type: "refreshing-empty" })

    expect(
      sessionLoadView({
        hasRenderableContent: false,
        messages: [],
        load: { phase: "error", generation: 2, hasSnapshot: true, error: "Offline" },
        delayed: false,
      }),
    ).toEqual({ type: "empty-error", error: "Offline" })
  })

  test("renderable content always wins over background loading state", () => {
    expect(
      sessionLoadView({
        hasRenderableContent: true,
        messages: [{ id: "msg_1" }],
        load: { phase: "refreshing", generation: 2, hasSnapshot: true },
        delayed: true,
      }),
    ).toEqual({ type: "conversation" })
  })
})
