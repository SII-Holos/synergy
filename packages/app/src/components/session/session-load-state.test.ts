import { describe, expect, test } from "bun:test"
import { hasSessionRenderableContent, sessionLoadView } from "./session-load-state"

const idle = { phase: "idle" as const, generation: 0, hasSnapshot: false }

describe("session renderable content", () => {
  test("recognizes messages, pending items, and transitions independently", () => {
    expect(
      hasSessionRenderableContent({
        hasActiveMessage: true,
        timelineCount: 0,
        pendingTimelineCount: 0,
        hasTransition: false,
      }),
    ).toBe(true)
    expect(
      hasSessionRenderableContent({
        hasActiveMessage: false,
        timelineCount: 1,
        pendingTimelineCount: 0,
        hasTransition: false,
      }),
    ).toBe(true)
    expect(
      hasSessionRenderableContent({
        hasActiveMessage: false,
        timelineCount: 0,
        pendingTimelineCount: 1,
        hasTransition: false,
      }),
    ).toBe(true)
    expect(
      hasSessionRenderableContent({
        hasActiveMessage: false,
        timelineCount: 0,
        pendingTimelineCount: 0,
        hasTransition: true,
      }),
    ).toBe(true)
  })

  test("keeps a truly empty session non-renderable", () => {
    expect(
      hasSessionRenderableContent({
        hasActiveMessage: false,
        timelineCount: 0,
        pendingTimelineCount: 0,
        hasTransition: false,
      }),
    ).toBe(false)
  })
})

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

  test("shows conversation for a transition before messages arrive", () => {
    const hasRenderableContent = hasSessionRenderableContent({
      hasActiveMessage: false,
      timelineCount: 0,
      pendingTimelineCount: 0,
      hasTransition: true,
    })

    expect(
      sessionLoadView({
        hasRenderableContent,
        messages: undefined,
        load: { phase: "loading", generation: 1, hasSnapshot: false },
        delayed: false,
      }),
    ).toEqual({ type: "conversation" })
  })

  test("shows conversation when only a queued first message remains", () => {
    const hasRenderableContent = hasSessionRenderableContent({
      hasActiveMessage: false,
      timelineCount: 0,
      pendingTimelineCount: 1,
      hasTransition: false,
    })

    expect(
      sessionLoadView({
        hasRenderableContent,
        messages: [],
        load: { ...idle, phase: "ready", hasSnapshot: true },
        delayed: false,
      }),
    ).toEqual({ type: "conversation" })
  })
})
