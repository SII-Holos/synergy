import { describe, expect, test } from "bun:test"
import { tmpdir } from "../support/fixture"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInteraction } from "../../src/session/interaction"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { SessionWorkflowHold } from "../../src/session/workflow-hold"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"

function storedInfo(scopeID: string, sessionID: string) {
  return Storage.read<Record<string, unknown>>(
    StoragePath.sessionInfo(Identifier.asScopeID(scopeID), Identifier.asSessionID(sessionID)),
  )
}

function cortexDelegation() {
  return {
    taskID: "tsk_workflow_hold",
    parentSessionID: "ses_parent",
    parentMessageID: "msg_parent",
    description: "delegated work",
    agent: "synergy",
    startedAt: Date.now(),
    status: "running" as const,
  }
}

describe("SessionWorkflowHold", () => {
  test("produces a workflow latch for a bound session that carries no pause", () => {
    const latch = SessionWorkflowHold.latchFor({ time: { created: 1 } })

    expect(latch?.reason).toBe("workflow")
    expect(latch?.description).toBe(SessionWorkflowHold.DESCRIPTION)
    expect(typeof latch?.since).toBe("number")
  })

  test("first pause wins, so a session another path already stopped is left alone", () => {
    const latch = SessionWorkflowHold.latchFor({
      time: { created: 1 },
      paused: { reason: "aborted", since: 5 },
    })

    expect(latch).toBeUndefined()
  })

  test("refuses every record the latch does not apply to", () => {
    expect(SessionWorkflowHold.latchFor(undefined)).toBeUndefined()
    // No `time` at all is unreachable state rather than a stoppable session.
    expect(SessionWorkflowHold.latchFor({})).toBeUndefined()
    expect(SessionWorkflowHold.latchFor({ time: { created: 1, archived: 2 } })).toBeUndefined()
    expect(SessionWorkflowHold.latchFor({ time: { created: 1 }, interaction: { mode: "unattended" } })).toBeUndefined()
    expect(SessionWorkflowHold.latchFor({ time: { created: 1 }, cortex: cortexDelegation() })).toBeUndefined()
  })

  test("latches a resident session and does not churn an existing pause", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scopeID = ScopeContext.current.scope.id
        const session = await Session.create({ title: "Held by a workflow" })

        expect(await SessionWorkflowHold.latch(scopeID, session.id)).toBe(true)
        const info = await storedInfo(scopeID, session.id)
        expect(info?.paused).toMatchObject({
          reason: "workflow",
          description: SessionWorkflowHold.DESCRIPTION,
        })

        // Re-running the upgrade finds the session already stopped, so it must
        // report no change rather than rewrite `since`.
        expect(await SessionWorkflowHold.latch(scopeID, session.id)).toBe(false)
        expect(await storedInfo(scopeID, session.id)).toEqual(info)
      },
    })
  })

  test("matches SessionLifecycle.pause on every session the latch excludes", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scopeID = ScopeContext.current.scope.id

        // `workflow-hold.ts` mirrors `SessionLifecycle.latchable` because a
        // migration cannot use the writer. The two rules are one rule owned in
        // two places, so this pairs them: if either side gains or loses an
        // exclusion, these assertions fail together rather than drifting.
        const archived = await Session.create({ title: "Archived" })
        await Session.update(archived.id, (draft) => {
          draft.time.archived = Date.now()
        })
        const unattended = await Session.create({
          title: "Machine session",
          interaction: SessionInteraction.unattended("channel:test"),
        })
        const cortex = await Session.create({ title: "Delegated", cortex: cortexDelegation() })

        for (const session of [archived, unattended, cortex]) {
          expect(await SessionWorkflowHold.latch(scopeID, session.id)).toBe(false)
          expect((await storedInfo(scopeID, session.id))?.paused).toBeUndefined()
          expect(await SessionLifecycle.pause({ sessionID: session.id, reason: "workflow" })).toBe(false)
          expect(await SessionLifecycle.snapshot(session.id)).toBeUndefined()
        }

        // The converse keeps the pairing from passing vacuously: an ordinary
        // interactive session is latchable through both rules.
        const ordinary = await Session.create({ title: "Interactive" })
        expect(await SessionWorkflowHold.latch(scopeID, ordinary.id)).toBe(true)
      },
    })
  })
})
