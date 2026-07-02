import { describe, expect, test } from "bun:test"
import type { BlueprintLoopInfo } from "@ericsanchezok/synergy-sdk/client"
import {
  blueprintRequestErrorMessage,
  resolveBlueprintSlotDisplay,
  type BlueprintSlotDisplay,
} from "./blueprint-slot"
import type { BlueprintSlot } from "./types"

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
})

describe("prompt blueprint request errors", () => {
  test("uses top-level backend error messages", () => {
    expect(blueprintRequestErrorMessage({ message: "BlueprintLoopInvalidTransition", data: { from: "cancelled" } }))
      .toBe("BlueprintLoopInvalidTransition")
  })

  test("uses nested data messages before falling back", () => {
    expect(blueprintRequestErrorMessage({ data: { message: "Loop not found" } })).toBe("Loop not found")
    expect(blueprintRequestErrorMessage({})).toBe("Request failed")
  })
})
