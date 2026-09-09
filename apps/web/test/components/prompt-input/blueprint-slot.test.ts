import { describe, expect, test } from "bun:test"
import type { BlueprintLoopInfo } from "@ericsanchezok/synergy-sdk/client"
import {
  blueprintRequestErrorMessage,
  isTerminalBlueprintLoopStatus,
  resolveBlueprintSlotDisplay,
  type BlueprintSlotDisplay,
} from "../../../src/components/prompt-input/blueprint-slot"
import type { BlueprintSlot } from "../../../src/components/prompt-input/types"

function loop(status: BlueprintLoopInfo["status"] = "running") {
  return {
    id: "bll_active",
    noteID: "note_blueprint",
    title: "Active Blueprint",
    runMode: "current" as const,
    status: status as any,
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
