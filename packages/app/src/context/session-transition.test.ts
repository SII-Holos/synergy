import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import {
  createNewSessionTransitionProgress,
  createNewSessionTransitionSuccessProgress,
} from "@/components/session/session-transition-progress"
import { createSessionTransitionState } from "./session-transition"

describe("session transition state", () => {
  test("retains a transition for a remounted session route consumer", () => {
    createRoot((dispose) => {
      const state = createSessionTransitionState()
      const progress = createNewSessionTransitionProgress()

      state.set("session-1", progress)

      const readAfterRouteRemount = () => state.get("session-1")
      expect(readAfterRouteRemount()?.progress).toBe(progress)
      dispose()
    })
  })

  test("ignores a stale dismiss after a newer transition replaces the entry", () => {
    createRoot((dispose) => {
      const state = createSessionTransitionState()
      const success = createNewSessionTransitionSuccessProgress()
      state.set("session-1", success, {
        dismiss: () => state.clear("session-1"),
      })
      const staleDismiss = state.get("session-1")?.actions?.dismiss
      const loading = createNewSessionTransitionProgress()

      state.set("session-1", loading)
      staleDismiss?.()

      expect(state.get("session-1")?.progress).toBe(loading)
      dispose()
    })
  })
})
