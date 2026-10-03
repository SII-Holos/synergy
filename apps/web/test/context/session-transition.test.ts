import { TEST_AGENT_NAME } from "@ericsanchezok/synergy-testing/agent-fixture"
import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import {
  createNewSessionTransitionProgress,
  createNewSessionTransitionSuccessProgress,
} from "@/components/session/session-transition-progress"
import type { NewSessionRecovery } from "@/components/session/new-session-recovery"
import type { SessionTransitionHandoff } from "@/components/session/session-transition-handoff"
import { createSessionTransitionState } from "../../src/context/session-transition"

describe("session transition state", () => {
  test("publishes preparation before an ID exists and atomically hands it to the session", () => {
    createRoot((dispose) => {
      const state = createSessionTransitionState()
      const lease = state.prepareDraft("draft:connection/scope")
      expect(state.get("draft:connection/scope")?.progress.phase).toBe("loading")
      lease.setText("Inspect the project")
      expect(state.get("draft:connection/scope")?.draft?.text).toBe("Inspect the project")
      expect(lease.handoff("session-1", createNewSessionTransitionProgress())).toBe(true)
      expect(state.get("draft:connection/scope")).toBeUndefined()
      expect(state.get("session-1")?.draft?.text).toBe("Inspect the project")
      lease.clear()
      expect(state.get("session-1")).toBeDefined()
      dispose()
    })
  })
  test("stale preparation cannot replace or clear a newer submission", () => {
    createRoot((dispose) => {
      const state = createSessionTransitionState()
      const stale = state.prepareDraft("draft:scope")
      const current = state.prepareDraft("draft:scope")
      stale.setText("stale")
      stale.clear()
      expect(stale.handoff("wrong", createNewSessionTransitionProgress())).toBe(false)
      current.setText("current")
      expect(state.get("draft:scope")?.draft?.text).toBe("current")
      expect(state.get("wrong")).toBeUndefined()
      dispose()
    })
  })
  test("retains a transition for a remounted session route consumer", () => {
    createRoot((dispose) => {
      const state = createSessionTransitionState()
      const progress = createNewSessionTransitionProgress()

      state.set("session-1", progress)

      const readAfterRouteRemount = () => state.get("session-1")
      expect(readAfterRouteRemount()?.progress).toEqual(progress)
      dispose()
    })
  })

  test("remembers a dismissed handoff across remounted session route consumers", () => {
    createRoot((dispose) => {
      const state = createSessionTransitionState()
      state.set("session-1", createNewSessionTransitionSuccessProgress())

      state.dismissHandoff("session-1", "msg_first")

      const readAfterRouteRemount = () => state.isHandoffDismissed("session-1", "msg_first")
      expect(state.get("session-1")).toBeUndefined()
      expect(readAfterRouteRemount()).toBe(true)
      expect(state.isHandoffDismissed("session-1", "msg_second")).toBe(false)
      dispose()
    })
  })

  test("retains the expected root handoff until the session route observes it", () => {
    createRoot((dispose) => {
      const state = createSessionTransitionState()
      const progress = createNewSessionTransitionProgress()
      const handoff = {
        messageID: "msg_first",
        success: createNewSessionTransitionSuccessProgress(),
      } satisfies SessionTransitionHandoff

      state.set("session-1", progress, undefined, handoff)

      expect(state.get("session-1")?.handoff).toEqual(handoff)
      dispose()
    })
  })

  test("dismisses a completed handoff after its loading entry is replaced", () => {
    createRoot((dispose) => {
      const state = createSessionTransitionState()
      const handoff = {
        messageID: "msg_first",
        success: createNewSessionTransitionSuccessProgress(),
      } satisfies SessionTransitionHandoff
      state.set("session-1", createNewSessionTransitionProgress(), undefined, handoff)

      expect(state.completeHandoff("session-1", "msg_first")).toBe(true)
      expect(() => state.get("session-1")?.actions?.dismiss?.()).not.toThrow()
      expect(state.get("session-1")).toBeUndefined()
      expect(state.isHandoffDismissed("session-1", "msg_first")).toBe(true)
      expect(state.completeHandoff("session-1", "msg_first")).toBe(false)
      dispose()
    })
  })

  test("canonical completion confirms a lost receipt once and cannot confirm a newer input", () => {
    createRoot((dispose) => {
      const state = createSessionTransitionState()
      let accepted = 0
      const handoff = {
        messageID: "msg_first",
        success: createNewSessionTransitionSuccessProgress(),
        unconfirmed: {
          missing() {},
          accepted() {
            accepted++
          },
        },
      } satisfies SessionTransitionHandoff
      state.set("session-1", createNewSessionTransitionProgress(), undefined, handoff)
      expect(state.completeHandoff("session-1", "stale")).toBe(false)
      expect(accepted).toBe(0)
      expect(state.completeHandoff("session-1", "msg_first")).toBe(true)
      expect(accepted).toBe(1)
      expect(state.completeHandoff("session-1", "msg_first")).toBe(false)
      expect(accepted).toBe(1)
      dispose()
    })
  })

  test("durable confirmation and canonical completion share one acceptance callback", () => {
    createRoot((dispose) => {
      const state = createSessionTransitionState()
      let accepted = 0
      state.set("session-1", createNewSessionTransitionProgress(), undefined, {
        messageID: "msg_first",
        success: createNewSessionTransitionSuccessProgress(),
        unconfirmed: {
          missing() {},
          accepted() {
            accepted++
          },
        },
      })
      expect(state.confirmHandoff("session-1", "stale")).toBe(false)
      expect(state.confirmHandoff("session-1", "msg_first")).toBe(true)
      expect(state.confirmHandoff("session-1", "msg_first")).toBe(false)
      expect(state.completeHandoff("session-1", "msg_first")).toBe(true)
      expect(accepted).toBe(1)
      dispose()
    })
  })

  test("does not complete a newer handoff from a stale message result", () => {
    createRoot((dispose) => {
      const state = createSessionTransitionState()
      const handoff = {
        messageID: "msg_second",
        success: createNewSessionTransitionSuccessProgress(),
      } satisfies SessionTransitionHandoff
      const loading = createNewSessionTransitionProgress()
      state.set("session-1", loading, undefined, handoff)

      expect(state.completeHandoff("session-1", "msg_first")).toBe(false)
      expect(state.get("session-1")?.progress).toEqual(loading)
      expect(state.get("session-1")?.handoff?.messageID).toBe("msg_second")
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

      expect(state.get("session-1")?.progress).toEqual(loading)
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
        boss: false,
        blueprintSlot: null,
        agent: TEST_AGENT_NAME,
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
