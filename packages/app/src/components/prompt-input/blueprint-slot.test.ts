import { describe, expect, test } from "bun:test"
import type { BlueprintLoopInfo } from "@ericsanchezok/synergy-sdk/client"
import {
  blueprintRequestErrorMessage,
  isTerminalBlueprintLoopStatus,
  resolveBlueprintSlotDisplay,
  resolveEffectiveBlueprintActiveLoopID,
  type BlueprintSlotDisplay,
} from "./blueprint-slot"
import type { BlueprintSlot } from "./types"

function loop(status: BlueprintLoopInfo["status"] = "running", overrides?: Partial<BlueprintLoopInfo>) {
  return {
    id: "bll_active",
    noteID: "note_blueprint",
    title: "Active Blueprint",
    runMode: "current" as const,
    status: status as any,
    sessionID: "ses_test",
    ...overrides,
  }
}

describe("prompt blueprint slot display", () => {
  test("does not display a stale session loop without an active loop ID", () => {
    expect(resolveBlueprintSlotDisplay({ sessionLoop: loop(), activeLoopID: undefined })).toBeNull()
  })

  test("does not display a session loop that no longer matches the active session loop", () => {
    expect(resolveBlueprintSlotDisplay({ sessionLoop: loop(), activeLoopID: "bll_other" })).toBeNull()
  })

  test("does not display terminal session loops", () => {
    const terminalStatuses: BlueprintLoopInfo["status"][] = ["completed", "failed", "cancelled"]
    for (const status of terminalStatuses) {
      expect(resolveBlueprintSlotDisplay({ sessionLoop: loop(status), activeLoopID: "bll_active" })).toBeNull()
    }
  })

  test("displays an active non-terminal session loop", () => {
    expect(resolveBlueprintSlotDisplay({ sessionLoop: loop("waiting"), activeLoopID: "bll_active" })).toEqual({
      slot: {
        type: "loop",
        loopID: "bll_active",
        noteID: "note_blueprint",
        title: "Active Blueprint",
        runMode: "current",
      },
      mode: "waiting",
    } satisfies BlueprintSlotDisplay)
  })

  test("local armed slots take priority over a stale session loop", () => {
    const localSlot: BlueprintSlot = {
      type: "pending",
      noteID: "note_local",
      title: "Local Blueprint",
      runMode: "current",
    }

    expect(resolveBlueprintSlotDisplay({ localSlot, sessionLoop: loop(), activeLoopID: undefined })).toEqual({
      slot: localSlot,
      mode: "pending",
    } satisfies BlueprintSlotDisplay)
  })

  test("displays all non-terminal statuses without returning null", () => {
    const nonTerminalStatuses: BlueprintLoopInfo["status"][] = ["armed", "running", "waiting", "auditing"]
    for (const status of nonTerminalStatuses) {
      const result = resolveBlueprintSlotDisplay({ sessionLoop: loop(status), activeLoopID: "bll_active" })
      expect(result).not.toBeNull()
      expect(result!.mode).toBe(status)
      expect(result!.slot).toEqual({
        type: "loop",
        loopID: "bll_active",
        noteID: "note_blueprint",
        title: "Active Blueprint",
        runMode: "current",
      })
    }
  })
})

describe("isTerminalBlueprintLoopStatus", () => {
  test("returns true for completed, failed, and cancelled", () => {
    expect(isTerminalBlueprintLoopStatus("completed")).toBe(true)
    expect(isTerminalBlueprintLoopStatus("failed")).toBe(true)
    expect(isTerminalBlueprintLoopStatus("cancelled")).toBe(true)
  })

  test("returns false for non-terminal statuses", () => {
    expect(isTerminalBlueprintLoopStatus("armed")).toBe(false)
    expect(isTerminalBlueprintLoopStatus("running")).toBe(false)
    expect(isTerminalBlueprintLoopStatus("waiting")).toBe(false)
    expect(isTerminalBlueprintLoopStatus("auditing")).toBe(false)
  })

  test("returns false for nullish and unknown values", () => {
    expect(isTerminalBlueprintLoopStatus(null)).toBe(false)
    expect(isTerminalBlueprintLoopStatus(undefined)).toBe(false)
    expect(isTerminalBlueprintLoopStatus("unknown")).toBe(false)
    expect(isTerminalBlueprintLoopStatus("")).toBe(false)
  })
})

describe("prompt blueprint request errors", () => {
  test("uses top-level backend error messages", () => {
    expect(
      blueprintRequestErrorMessage({ message: "BlueprintLoopInvalidTransition", data: { from: "cancelled" } }),
    ).toBe("BlueprintLoopInvalidTransition")
  })

  test("uses nested data messages before falling back", () => {
    expect(blueprintRequestErrorMessage({ data: { message: "Loop not found" } })).toBe("Loop not found")
    expect(blueprintRequestErrorMessage({})).toBe("Request failed")
  })
})

describe("resolveEffectiveBlueprintActiveLoopID", () => {
  test("session active ID wins over optimistic ID", () => {
    expect(
      resolveEffectiveBlueprintActiveLoopID({
        sessionID: "ses_test",
        sessionActiveLoopID: "bll_active",
        optimisticLoopID: "bll_optimistic",
      }),
    ).toBe("bll_active")
  })

  test("session active ID wins over sessionLoop", () => {
    expect(
      resolveEffectiveBlueprintActiveLoopID({
        sessionID: "ses_test",
        sessionActiveLoopID: "bll_active",
        sessionLoop: { id: "bll_other", sessionID: "ses_test", status: "running" },
      }),
    ).toBe("bll_active")
  })

  test("non-terminal sessionLoop for current session bridges missing active ID", () => {
    expect(
      resolveEffectiveBlueprintActiveLoopID({
        sessionID: "ses_test",
        sessionActiveLoopID: undefined,
        sessionLoop: { id: "bll_bridge", sessionID: "ses_test", status: "running" },
      }),
    ).toBe("bll_bridge")
  })

  test("non-terminal sessionLoop for current session bridges null active ID", () => {
    expect(
      resolveEffectiveBlueprintActiveLoopID({
        sessionID: "ses_test",
        sessionActiveLoopID: null,
        sessionLoop: { id: "bll_bridge", sessionID: "ses_test", status: "waiting" },
      }),
    ).toBe("bll_bridge")
  })

  test("loop for another session does not bridge", () => {
    expect(
      resolveEffectiveBlueprintActiveLoopID({
        sessionID: "ses_test",
        sessionActiveLoopID: undefined,
        sessionLoop: { id: "bll_other", sessionID: "ses_other", status: "running" },
      }),
    ).toBeUndefined()
  })

  test("terminal loop never bridges", () => {
    const terminalStatuses: BlueprintLoopInfo["status"][] = ["completed", "failed", "cancelled"]
    for (const status of terminalStatuses) {
      expect(
        resolveEffectiveBlueprintActiveLoopID({
          sessionID: "ses_test",
          sessionActiveLoopID: undefined,
          sessionLoop: { id: "bll_done", sessionID: "ses_test", status },
        }),
      ).toBeUndefined()
    }
  })

  test("optimistic loop ID matches sessionLoop when no active ID", () => {
    expect(
      resolveEffectiveBlueprintActiveLoopID({
        sessionID: "ses_test",
        sessionActiveLoopID: undefined,
        optimisticLoopID: "bll_opt",
        sessionLoop: { id: "bll_opt", sessionID: "ses_test", status: "running" },
      }),
    ).toBe("bll_opt")
  })

  test("optimistic loop ID mismatching sessionLoop still bridges when sessionLoop belongs to current session", () => {
    // The session loop for current session bridges regardless of optimistic ID.
    expect(
      resolveEffectiveBlueprintActiveLoopID({
        sessionID: "ses_test",
        sessionActiveLoopID: undefined,
        optimisticLoopID: "bll_mismatch",
        sessionLoop: { id: "bll_other", sessionID: "ses_test", status: "running" },
      }),
    ).toBe("bll_other")
  })

  test("optimistic loop ID with terminal sessionLoop returns undefined", () => {
    expect(
      resolveEffectiveBlueprintActiveLoopID({
        sessionID: "ses_test",
        sessionActiveLoopID: undefined,
        optimisticLoopID: "bll_opt",
        sessionLoop: { id: "bll_opt", sessionID: "ses_test", status: "completed" },
      }),
    ).toBeUndefined()
  })

  test("undefined everything returns undefined", () => {
    expect(
      resolveEffectiveBlueprintActiveLoopID({
        sessionID: undefined,
        sessionActiveLoopID: undefined,
        optimisticLoopID: undefined,
        sessionLoop: undefined,
      }),
    ).toBeUndefined()
  })

  test("null everything returns undefined", () => {
    expect(
      resolveEffectiveBlueprintActiveLoopID({
        sessionID: null,
        sessionActiveLoopID: null,
        optimisticLoopID: null,
        sessionLoop: null,
      }),
    ).toBeUndefined()
  })

  test("no sessionLoop and no active ID returns undefined", () => {
    expect(
      resolveEffectiveBlueprintActiveLoopID({
        sessionID: "ses_test",
        sessionActiveLoopID: undefined,
      }),
    ).toBeUndefined()
  })
})
