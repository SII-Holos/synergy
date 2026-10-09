import { afterAll, expect, spyOn, test } from "bun:test"
import { fixture, complete } from "../support/rollout"
import { testRuntime } from "../support/runtime"
import { Session } from "../../src/session"
import { SessionHistory } from "../../src/session/history"
import { SessionActivity } from "../../src/session/activity"
import { SessionInbox } from "../../src/session/inbox"
import { MessageV2 } from "../../src/session/message-v2"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutLifecycle } from "../../src/session/rollout/lifecycle"
import { Bus } from "../../src/bus"
import { SessionActivityEvent } from "../../src/session/activity-events"
import { Identifier } from "../../src/id/id"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"

const runtime = await testRuntime()
afterAll(() => runtime.close())

async function foreground(sessionID: string, rootID: string, owner: Parameters<typeof RolloutLedger.getRun>[0]) {
  const segment = await RolloutLedger.beginSegment({ owner, runID: rootID, input: {} })
  const reply = (await SessionHistory.messages({ sessionID })).findLast(
    (message) => message.info.role === "assistant",
  )!.info
  if (reply.role !== "assistant") throw new Error("Missing assistant fixture")
  const completed = Date.now()
  await Session.updateMessage({ ...reply, time: { created: segment.started, completed } })
  return { segment, completed }
}

test("foreground completion publishes before detached work and preserves its eventual accounting", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      const { segment, completed } = await foreground(session.id, rootID, call.owner)
      expect((await SessionActivity.turns(session.id, [rootID]))[0].status).toBe("running")
      const events: string[] = []
      const dispose = Bus.subscribe(SessionActivityEvent.Execution, (event) => {
        events.push(event.properties.rootID)
      })
      try {
        await RolloutLedger.finishSegment(segment, "completed")
        await RolloutLedger.finishSegment(segment, "completed")
        expect(events).toEqual([rootID])
        const [state] = await SessionActivity.turns(session.id, [rootID])
        expect(state).toMatchObject({ status: "completed", endedAt: completed })
        expect(state).not.toHaveProperty("elapsedMs")
        expect(await RolloutLedger.getRun(call.owner, rootID)).toMatchObject({
          status: "running",
          execution: { status: "completed", at: expect.any(Number) },
        })
        expect((await RolloutLedger.getCall(call.owner, rootID, call.id)).status).toBe("running")
        await expect(RolloutLedger.finishRun(call.owner, rootID, "completed")).rejects.toThrow("active calls")
        await complete(call)
        await RolloutLifecycle.reconcile(session.id, rootID)
        expect((await RolloutLedger.getRun(call.owner, rootID)).status).toBe("completed")
        expect((await RolloutLedger.getCall(call.owner, rootID, call.id)).transportCaptured).toBe(true)
        expect((await SessionActivity.turns(session.id, [rootID]))[0]).toEqual(state)
      } finally {
        dispose()
      }
    }),
  ))

test("completion uses canonical message metadata without hydrating response bodies", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      const { segment } = await foreground(session.id, rootID, call.owner)
      await RolloutLedger.finishSegment(segment, "completed")
      await SessionHistory.prepareDisplay(session.id)
      using parts = spyOn(MessageV2, "parts")
      expect((await SessionActivity.turns(session.id, [rootID]))[0].status).toBe("completed")
      expect(parts).not.toHaveBeenCalled()
    }),
  ))

test("an owning child must settle before the reply completes, while another root's child does not block it", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      const { segment } = await foreground(session.id, rootID, call.owner)
      await RolloutLedger.finishSegment(segment, "completed")
      const child = await Session.create({
        parentID: session.id,
        cortex: {
          taskID: "completion-test",
          parentSessionID: session.id,
          parentMessageID: rootID,
          description: "Verify completion",
          agent: "test",
          startedAt: Date.now(),
          status: "running",
        },
      })
      expect((await SessionActivity.turns(session.id, [rootID]))[0].status).toBe("running")
      await Session.update(child.id, (draft) => {
        draft.cortex!.status = "completed"
      })
      expect((await SessionActivity.turns(session.id, [rootID]))[0].status).toBe("running")
      await Session.update(child.id, (draft) => {
        draft.cortex!.settledAt = Date.now()
      })
      expect((await SessionActivity.turns(session.id, [rootID]))[0].status).toBe("completed")
      const root = (await MessageV2.get({ sessionID: session.id, messageID: rootID })).info
      if (root.role !== "user") throw new Error("Missing user fixture")
      const otherID = Identifier.ascending("message")
      await Session.updateMessage({ ...root, id: otherID, rootID: otherID, time: { created: Date.now() } })
      await Session.update(child.id, (draft) => {
        draft.cortex!.parentMessageID = otherID
        draft.cortex!.status = "running"
        draft.cortex!.settledAt = undefined
      })
      expect((await SessionActivity.turns(session.id, [rootID]))[0].status).toBe("completed")
    }),
  ))

test("completion respects message chronology and rollback visibility", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      const { segment, completed } = await foreground(session.id, rootID, call.owner)
      await RolloutLedger.finishSegment(segment, "completed")
      const reply = (await SessionHistory.messages({ sessionID: session.id })).findLast(
        (message) => message.info.role === "assistant",
      )!.info
      const root = (await MessageV2.get({ sessionID: session.id, messageID: rootID })).info
      if (root.role !== "user") throw new Error("Missing user fixture")
      await Session.updateMessage({
        ...root,
        id: Identifier.ascending("message"),
        isRoot: false,
        rootID,
        time: { created: segment.started - 1 },
      })
      expect(await SessionHistory.turnCompletion(session.id, rootID)).toEqual({ completedAt: completed, failed: false })
      const historyID = Identifier.ascending("history")
      await Storage.write(
        StoragePath.sessionHistoryEvent(
          Identifier.asScopeID(session.scope.id),
          Identifier.asSessionID(session.id),
          historyID,
        ),
        {
          id: historyID,
          sessionID: session.id,
          type: "rollback",
          time: { created: Date.now() },
          numTurns: 1,
          cutMessageID: reply.id,
          droppedMessageIDs: [reply.id],
          droppedUserMessageIDs: [],
          files: [],
          patchPartIDs: [],
        } satisfies SessionHistory.RollbackEvent,
      )
      expect(await SessionHistory.turnCompletion(session.id, rootID)).toBeUndefined()
    }),
  ))

test("unanswered steering keeps the foreground open after an earlier reply", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      const { segment } = await foreground(session.id, rootID, call.owner)
      await RolloutLedger.finishSegment(segment, "completed")
      await SessionInbox.enqueueUser({
        sessionID: session.id,
        model: { providerID: "test", modelID: "test" },
        noReply: true,
        parts: [{ type: "text", text: "Please also check the edge case" }],
      })
      for (const item of await SessionInbox.peekSteer(session.id))
        await SessionInbox.materializeItem(item, rootID, { guiding: true })
      expect((await SessionActivity.turns(session.id, [rootID]))[0].status).toBe("running")
    }),
  ))
