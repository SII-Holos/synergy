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
const light = (patch: object = {}): Session["workflow"] => ({ kind: "lightloop", instructions: "Acceptance", ...patch })
const paused = { type: "paused", reason: "aborted", since: 1 } as const
const stopRequest = {
  summary: "Ready for review",
  requestedAt: 1,
  requesterSessionID: "session",
  requesterMessageID: "msg",
}

describe("Loop presentation follows independent review", () => {
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
  test.each(["blueprint", "lightloop"] as const)(
    "%s does not mistake an idle reviewer or paused run for completion",
    (kind) => {
      const input =
        kind === "blueprint"
          ? { blueprint: { ...loop, status: "auditing" as const } }
          : { workflow: light({ stopRequest }) }
      expect(resolveLoopDisplay({ ...input, status: { type: "idle" } })?.stage).toBe("auditing")
      expect(resolveLoopDisplay({ ...input, status: paused })?.stage).toBe("paused")
    },
  )
  test.each(["blueprint", "lightloop"] as const)(
    "%s shows rejected work, reason, later review and authoritative approval",
    (kind) => {
      const rejected =
        kind === "blueprint"
          ? { blueprint: { ...loop, audit: { attempts: 1, lastReason: "Missing failure recovery" } } }
          : { workflow: light({ review: { attempts: 1, lastReason: "Missing failure recovery" } }) }
      expect(resolveLoopDisplay({ ...rejected, status: { type: "busy" } })).toMatchObject({
        stage: "rework",
        reason: "Missing failure recovery",
        terminal: false,
      })
      const reviewing =
        kind === "blueprint"
          ? { blueprint: { ...rejected.blueprint!, status: "auditing" as const } }
          : { workflow: light({ review: { attempts: 1, lastReason: "Missing failure recovery" }, stopRequest }) }
      expect(resolveLoopDisplay({ ...reviewing, status: { type: "busy" } })?.stage).toBe("auditing")
      const completed =
        kind === "blueprint"
          ? { blueprint: { ...loop, status: "completed" as const, summary: "Recovery verified" } }
          : { lightTerminal: { instructions: "Acceptance", status: "completed" as const, createdAt: 3 } }
      expect(resolveLoopDisplay({ ...completed, status: paused })).toMatchObject({ stage: "completed", terminal: true })
    },
  )
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
        lightTerminal: { status: "completed", instructions: "old", createdAt: 9 },
        status: { type: "busy" },
      }),
    ).toMatchObject({ kind: "blueprint", terminal: false })
  })
})
