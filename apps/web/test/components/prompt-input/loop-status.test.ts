import { describe, expect, test } from "bun:test"
import type { BlueprintLoopInfo, Session } from "@ericsanchezok/synergy-sdk/client"
import { resolveLoopDisplay } from "../../../src/components/prompt-input/loop-status"

const loop: BlueprintLoopInfo = {
  id: "loop",
  sessionID: "session",
  scopeID: "home",
  noteID: "note",
  title: "Acceptance",
  status: "running",
  source: "user",
  auditAgent: "supervisor",
  time: { created: 1, updated: 2 },
}
const blueprintBinding: NonNullable<Session["blueprint"]> = {
  loopID: loop.id,
  source: "user",
  loopRole: "execution",
  phase: "running",
}
const light = (patch: object = {}): Session["workflow"] => ({ kind: "lightloop", instructions: "Acceptance", ...patch })
const paused = { type: "paused", reason: "aborted", since: 1 } as const
const stopRequest = {
  summary: "Ready for review",
  requestedAt: 1,
  requesterSessionID: "session",
  requesterMessageID: "msg",
}

describe("Loop presentation follows current attachments", () => {
  test.each(["running", "auditing", "completed", "failed", "cancelled"] as const)(
    "an unbound Blueprint with cached %s metadata leaves no composer row",
    (status) => {
      expect(resolveLoopDisplay({ blueprint: { ...loop, status }, status: { type: "idle" } })).toBeUndefined()
    },
  )
  test.each(["completed", "failed", "cancelled", "timed_out", "iteration_exhausted"] as const)(
    "an ended Light Loop with a %s result leaves no composer row",
    (status) => {
      const historical = {
        lightTerminal: { status, instructions: "Previous task", error: "Evidence", createdAt: 4 },
        status: { type: "idle" } as const,
      }
      expect(resolveLoopDisplay(historical)).toBeUndefined()
    },
  )
  test.each(["completed", "failed", "cancelled"] as const)(
    "Blueprint %s metadata cannot replace the Session binding as visibility authority",
    (status) => {
      expect(resolveLoopDisplay({ blueprint: { ...loop, status }, blueprintBinding, status: paused })).toMatchObject({
        kind: "blueprint",
        stage: status,
        terminal: true,
      })
      expect(resolveLoopDisplay({ blueprint: { ...loop, status }, status: paused })).toBeUndefined()
    },
  )
  test("Light Loop keeps its goal while bound, including idle and interrupted execution", () => {
    const instructions = "Repair missing final replies after background generation and preserve the history anchor"
    for (const status of [{ type: "busy" }, { type: "idle" }, paused] as const)
      expect(resolveLoopDisplay({ workflow: light({ instructions }), status })).toMatchObject({
        title: instructions,
        terminal: false,
        stage: status.type === "paused" ? "paused" : status.type === "idle" ? "bound" : "running",
      })
    const revised = instructions + " across reconnects"
    expect(resolveLoopDisplay({ workflow: light({ instructions: revised }), status: paused })?.title).toBe(revised)
  })
  test("a pending Blueprint choice is not a binding; bound states keep the note title", () => {
    const note = { id: "note", title: "Message flow: history loading and session switching" }
    const pending = {
      localBlueprint: { type: "pending", noteID: note.id, title: note.title, runMode: "current" },
      status: { type: "idle" } as const,
    }
    expect(resolveLoopDisplay(pending)).toBeUndefined()
    for (const status of ["armed", "running", "auditing"] as const)
      expect(
        resolveLoopDisplay({
          blueprint: { ...loop, noteID: note.id, title: note.title, status, stopRequest },
          blueprintBinding,
          status: { type: "idle" },
        }),
      ).toMatchObject({ title: note.title, noteID: note.id, terminal: false })
  })
  test("Blueprint does not mistake an idle reviewer or interrupted run for completion", () => {
    const input = { blueprint: { ...loop, status: "auditing" as const }, blueprintBinding }
    expect(resolveLoopDisplay({ ...input, status: { type: "idle" } })?.stage).toBe("auditing")
    expect(resolveLoopDisplay({ ...input, status: paused })?.stage).toBe("paused")
  })
  test("Blueprint keeps active rejection feedback and later review accessible", () => {
    const rejected = { ...loop, audit: { attempts: 1, lastReason: "Missing failure recovery" } }
    expect(resolveLoopDisplay({ blueprint: rejected, blueprintBinding, status: { type: "busy" } })).toMatchObject({
      stage: "rework",
      reason: "Missing failure recovery",
      terminal: false,
    })
    expect(
      resolveLoopDisplay({
        blueprint: { ...rejected, status: "auditing" },
        blueprintBinding,
        status: { type: "busy" },
      }),
    ).toMatchObject({ stage: "auditing", terminal: false })
  })
  test("an unavailable metadata read belongs only to a current binding", () => {
    expect(resolveLoopDisplay({ blueprintUnavailable: true, status: { type: "idle" } })).toBeUndefined()
    expect(
      resolveLoopDisplay({ blueprint: loop, blueprintBinding, blueprintUnavailable: true, status: paused }),
    ).toMatchObject({ stage: "unavailable", title: loop.title, terminal: false })
  })
  test("pending choices never create a row; only the current Session binding can", () => {
    const previous = { blueprint: { ...loop, status: "failed" as const }, status: { type: "idle" } as const }
    const pendingBlueprint = {
      ...previous,
      localBlueprint: { type: "pending", noteID: "new", title: "Next task", runMode: "current" },
    }
    const pendingLight = { ...previous, lightPending: true }
    expect(resolveLoopDisplay(pendingBlueprint)).toBeUndefined()
    expect(resolveLoopDisplay(pendingLight)).toBeUndefined()
    expect(resolveLoopDisplay({ ...previous, workflow: light(), status: { type: "busy" } })).toMatchObject({
      stage: "running",
      title: "Acceptance",
    })
    expect(resolveLoopDisplay({ ...previous, blueprintBinding: { ...blueprintBinding, loopID: "new" } })).toMatchObject(
      { kind: "blueprint", title: "", stage: "bound", terminal: false },
    )
  })
})
