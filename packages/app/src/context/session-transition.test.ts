import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import {
  createNewSessionTransitionProgress,
  createNewSessionTransitionSuccessProgress,
} from "@/components/session/session-transition-progress"
import type { NewSessionRecovery } from "@/components/session/new-session-recovery"
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

  test("retains new-session recovery across directory route changes", () => {
    createRoot((dispose) => {
      const state = createSessionTransitionState()
      const recovery: NewSessionRecovery = {
        draft: {
          version: 1,
          prompt: [{ type: "text", content: "Retry me", start: 0, end: 0 }],
          context: { items: [] },
        },
        mode: "normal",
        workspaceSelection: { mode: "create" },
        controlProfile: "guarded",
        plan: false,
        lattice: null,
        lightLoop: false,
        blueprintSlot: null,
        agent: "synergy",
        model: { providerID: "provider", modelID: "model" },
        autoSubmit: true,
      }

      state.setRecovery("/repo", recovery)
      expect(state.getRecovery("/repo")).toBe(recovery)
      state.clearRecovery("/repo")
      expect(state.getRecovery("/repo")).toBeUndefined()
      dispose()
    })
  })

  test("ignores stale retry and dismiss actions after a newer transition", () => {
    createRoot((dispose) => {
      const state = createSessionTransitionState()
      let retries = 0
      let dismissals = 0
      state.set("session-1", createNewSessionTransitionSuccessProgress(), {
        retry: () => retries++,
        dismiss: () => dismissals++,
      })
      const staleActions = state.get("session-1")?.actions

      state.set("session-1", createNewSessionTransitionProgress())
      staleActions?.retry?.()
      staleActions?.dismiss?.()

      expect(retries).toBe(0)
      expect(dismissals).toBe(0)
      dispose()
    })
  })
})
