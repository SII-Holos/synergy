import { describe, expect, test } from "bun:test"
import type { BlueprintLoopInfo, Session } from "@ericsanchezok/synergy-sdk/client"
import { resolveLoopDisplay, resolveLoopHistoryHint } from "../../../src/components/prompt-input/loop-status"

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

describe("Loop presentation follows domain terminal state", () => {
  test("an unbound cached running Blueprint cannot keep the rendered card active", () => {
    const display = resolveLoopDisplay({ blueprint: loop, status: { type: "idle" } })
    expect(display?.terminal ?? true).toBe(true)
    expect(display?.stage).not.toBe("running")
  })
  test("Light Loop keeps its goal as the label instead of execution or review summaries", () => {
    const instructions = "Repair missing final replies after background generation and preserve the history anchor"
    const reviewing = light({ instructions })
    expect(resolveLoopDisplay({ workflow: reviewing, status: { type: "busy" } })).toMatchObject({
      title: instructions,
      stage: "running",
    })
    const revised = instructions + " across reconnects"
    expect(resolveLoopDisplay({ workflow: light({ instructions: revised }), status: paused })?.title).toBe(revised)
    expect(
      resolveLoopDisplay({
        lightTerminal: { instructions: revised, status: "completed", createdAt: 3 },
        status: { type: "idle" },
      })?.title,
    ).toBe(revised)
  })
  test("Blueprint keeps the associated note title through binding, review and completion", () => {
    const note = { id: "note", title: "Message flow: history loading and session switching" }
    expect(
      resolveLoopDisplay({
        localBlueprint: { type: "pending", noteID: note.id, title: note.title, runMode: "current" },
        status: { type: "idle" },
      }),
    ).toMatchObject({ title: note.title, noteID: note.id })
    for (const status of ["running", "auditing", "completed"] as const)
      expect(
        resolveLoopDisplay({
          blueprint: { ...loop, noteID: note.id, title: note.title, status, stopRequest, summary: "Review passed" },
          blueprintBinding,
          status: { type: "idle" },
        }),
      ).toMatchObject({ title: note.title, noteID: note.id })
  })
  test("loaded metadata identifies a result and its reviewer without reading text", () => {
    const messages = [
      { id: "old", metadata: { source: "blueprint_loop_start", loopID: "old-loop" } },
      { id: "start", metadata: { workflow: "lightloop" } },
      { id: "approved", metadata: { source: "light_loop_approved", sourceSessionID: "reviewer" } },
      { id: "new", metadata: { source: "blueprint_loop_start", loopID: "new-loop" } },
      { id: "unrelated", metadata: { source: "render", loopID: "not-a-loop" } },
    ]
    expect(resolveLoopHistoryHint(messages)).toEqual({
      blueprintID: "new-loop",
      light: "approved",
      lightReview: "reviewer",
    })
    expect(resolveLoopHistoryHint([{ id: "ordinary" }])).toEqual({
      blueprintID: undefined,
      light: undefined,
      lightReview: undefined,
    })
  })
  test("Blueprint does not mistake an idle reviewer or paused run for completion", () => {
    const input = { blueprint: { ...loop, status: "auditing" as const }, blueprintBinding }
    expect(resolveLoopDisplay({ ...input, status: { type: "idle" } })?.stage).toBe("auditing")
    expect(resolveLoopDisplay({ ...input, status: paused })?.stage).toBe("paused")
  })
  test("Blueprint shows rejected work, reason, later review and authoritative approval", () => {
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
      })?.stage,
    ).toBe("auditing")
    expect(
      resolveLoopDisplay({
        blueprint: { ...loop, status: "completed", summary: "Recovery verified" },
        blueprintBinding,
        status: paused,
      }),
    ).toMatchObject({ stage: "completed", terminal: true })
  })
  test.each(["failed", "cancelled", "timed_out", "iteration_exhausted"] as const)(
    "keeps %s distinct from approval",
    (status) => {
      expect(
        resolveLoopDisplay({
          lightTerminal: { status, instructions: "task", error: "Evidence", createdAt: 4 },
          status: { type: "idle" },
        }),
      ).toMatchObject({ stage: status, reason: "Evidence", terminal: true })
    },
  )
  test("a new binding wins over an older result", () => {
    expect(
      resolveLoopDisplay({
        localBlueprint: { type: "pending", noteID: "new", title: "Next task", runMode: "current" },
        blueprint: { ...loop, status: "failed" },
        status: { type: "idle" },
      }),
    ).toMatchObject({ stage: "bound", title: "Next task", pending: true })
    expect(
      resolveLoopDisplay({
        workflow: light(),
        lightTerminal: { status: "failed", instructions: "old", createdAt: 9 },
        status: { type: "busy" },
      }),
    ).toMatchObject({ stage: "running", title: "Acceptance" })
    expect(
      resolveLoopDisplay({
        blueprintBinding: { loopID: "new", source: "user", loopRole: "execution", phase: "running" },
        blueprint: { ...loop, status: "failed" },
        lightTerminal: { status: "completed", instructions: "old", createdAt: 9 },
        status: { type: "busy" },
      }),
    ).toMatchObject({ kind: "blueprint", title: "", stage: "bound", terminal: false })
  })
})
