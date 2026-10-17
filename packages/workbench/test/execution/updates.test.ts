import { RolloutExecution } from "@ericsanchezok/synergy-harness/rollout"
import { afterAll, expect, spyOn, test } from "bun:test"
import { z } from "zod"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { RolloutEvents } from "@ericsanchezok/synergy-harness/rollout"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutTransportRecorder } from "@ericsanchezok/synergy-harness/session/rollout/transport-recorder"
import { complete, contextDraft, fixture } from "@ericsanchezok/synergy-harness/test/support/rollout"
import { testRuntime } from "../support/runtime"
import { ExecutionSchema } from "../../src/execution/schema"
import { ExecutionService } from "../../src/execution/service"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("updates to an inactive execution cache do not reread its message history", () =>
  runtime.run(() =>
    fixture(async ({ session }) => {
      await ExecutionService.summary(session.id)
      using reads = spyOn(MessageV2, "stream")
      await Session.update(session.id, (info) => {
        info.title = "Changed while hidden"
      })
      const summary = await ExecutionService.summary(session.id)
      expect(summary.sessionID).toBe(session.id)
      const page = await ExecutionService.trajectory(
        session.id,
        ExecutionSchema.Query.parse({ mode: "records", kind: "turn" }),
      )
      expect(page.items[0].title).toBe("Changed while hidden")
      expect(reads).not.toHaveBeenCalled()
    }),
  ))

test("consecutive revisions of one record during loading do not rebuild the task tree", () =>
  runtime.run(() =>
    fixture(async ({ session, call }) => {
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const list = SessionInbox.list
      let held = false
      using inbox = spyOn(SessionInbox, "list").mockImplementation(async (id) => {
        const result = await list(id)
        if (id === session.id && !held) {
          held = true
          entered.resolve()
          await release.promise
        }
        return result
      })
      using reads = spyOn(MessageV2, "stream")
      const pending = ExecutionService.summary(session.id)
      try {
        await entered.promise
        for (let index = 0; index < 3; index++)
          await RolloutLedger.updateContextEstimate(call.owner, call.runID, call.id, {
            ...contextDraft(10 + index),
            version: 1,
            capturedAt: Date.now(),
          })
      } finally {
        release.resolve()
      }
      await pending
      expect(reads.mock.calls.filter(([input]) => input.sessionID === session.id)).toHaveLength(1)
    }),
  ))

test("unrelated output during a message refresh cannot extend its finite revision cut", () =>
  runtime.run(() =>
    fixture(async ({ session }) => {
      const other = await Session.create({ title: "Unrelated producer" })
      const messages = await Session.messages({ sessionID: session.id })
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const list = SessionInbox.list
      using inbox = spyOn(SessionInbox, "list").mockImplementation(async (id) => {
        const items = await list(id)
        if (id === session.id) {
          entered.resolve()
          await release.promise
        }
        return items
      })
      const get = MessageV2.get
      let reads = 0
      using read = spyOn(MessageV2, "get").mockImplementation(
        Object.assign(async (input: Parameters<typeof get>[0]) => {
          if (input.sessionID === session.id && reads++ < 8)
            await Session.update(other.id, (info) => {
              info.title = `Output ${reads}`
            })
          return get(input)
        }, get),
      )
      const loading = ExecutionService.summary(session.id)
      try {
        await entered.promise
        await Session.updateMessage(messages[0].info)
      } finally {
        release.resolve()
      }
      expect((await loading).sessionID).toBe(session.id)
      expect(reads).toBe(1)
    }),
  ))

test("adding a child reads only the new branch", () =>
  runtime.run(() =>
    fixture(async ({ session }) => {
      await ExecutionService.summary(session.id)
      using read = spyOn(MessageV2, "stream")
      const child = await Session.create({ parentID: session.id, title: "New child" })
      expect((await ExecutionService.summary(session.id)).tasks.some((task) => task.sessionID === child.id)).toBe(true)
      expect(read.mock.calls.map(([input]) => input.sessionID)).toEqual([child.id])
    }),
  ))

test("one cancelled reader leaves a shared execution load available to its other reader", () =>
  runtime.run(() =>
    fixture(async ({ session }) => {
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const children = Session.children
      using read = spyOn(Session, "children").mockImplementation(
        Object.assign(async (id: string) => {
          if (id === session.id) {
            entered.resolve()
            await release.promise
          }
          return children(id)
        }, children),
      )
      const controller = new AbortController()
      const first = ExecutionService.summary(session.id, undefined, controller.signal)
      await entered.promise
      const second = ExecutionService.summary(session.id)
      await Bun.sleep(0)
      controller.abort()
      await expect(first).rejects.toHaveProperty("name", "AbortError")
      release.resolve()
      expect((await second).sessionID).toBe(session.id)
      expect(read.mock.calls.filter(([id]) => id === session.id)).toHaveLength(1)
    }),
  ))

test("the last cancelled reader stops subsequent owner reads", () =>
  runtime.run(() =>
    fixture(async ({ session }) => {
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const children = Session.children
      using read = spyOn(Session, "children").mockImplementation(
        Object.assign(async (id: string) => {
          if (id === session.id) {
            entered.resolve()
            await release.promise
          }
          return children(id)
        }, children),
      )
      using messages = spyOn(MessageV2, "stream")
      const controller = new AbortController()
      const loading = ExecutionService.summary(session.id, undefined, controller.signal)
      await entered.promise
      controller.abort()
      await expect(loading).rejects.toHaveProperty("name", "AbortError")
      release.resolve()
      await Bun.sleep(25)
      expect(messages).not.toHaveBeenCalled()
    }),
  ))

test("a new reader arriving during cancellation starts a fresh execution load", () =>
  runtime.run(() =>
    fixture(async ({ session }) => {
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const children = Session.children
      let held = false
      using read = spyOn(Session, "children").mockImplementation(
        Object.assign(async (id: string) => {
          if (id === session.id && !held) {
            held = true
            entered.resolve()
            await release.promise
          }
          return children(id)
        }, children),
      )
      const controller = new AbortController()
      const first = ExecutionService.summary(session.id, undefined, controller.signal)
      await entered.promise
      controller.abort()
      await expect(first).rejects.toHaveProperty("name", "AbortError")
      const second = ExecutionService.summary(session.id)
      release.resolve()
      expect((await second).sessionID).toBe(session.id)
      expect(read.mock.calls.filter(([id]) => id === session.id)).toHaveLength(2)
    }),
  ))

test("a delayed inbox read cannot attach a newer revision to stale active intervals", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      const releaseSubscription = ExecutionService.subscribe(session.id)
      await complete(call)
      const segment = await RolloutLedger.beginSegment({ owner: call.owner, runID: rootID, input: {} })
      await RolloutExecution.provide({ owner: call.owner, runID: rootID }, () => RolloutExecution.start(segment))
      expect((await ExecutionService.summary(session.id)).elapsedActive).toBe(true)
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const list = SessionInbox.list
      let held = false
      const read = spyOn(SessionInbox, "list").mockImplementation(async (sessionID) => {
        const items = await list(sessionID)
        if (sessionID === session.id && !held) {
          held = true
          entered.resolve()
          await release.promise
        }
        return items
      })
      const pending = ExecutionService.summary(session.id)
      try {
        await Promise.race([entered.promise, pending])
        await RolloutExecution.stop(segment)
        await RolloutLedger.finishSegment(segment, "completed")
        await RolloutLedger.finishRun(call.owner, rootID, "completed")
        const completed = await ExecutionService.summary(session.id)
        expect(completed.elapsedActive).toBe(false)
        release.resolve()
        const delayed = await pending
        if (delayed.revision >= completed.revision) {
          expect(delayed.status).toBe("completed")
          expect(delayed.elapsedActive).toBe(false)
          expect(delayed.elapsedMs).toBe(completed.elapsedMs)
        } else expect(delayed.sampledAt).toBeLessThanOrEqual(completed.sampledAt)
        expect((await ExecutionService.summary(session.id)).elapsedActive).toBe(false)
      } finally {
        release.resolve()
        await pending
        read.mockRestore()
        releaseSubscription()
      }
    }),
  ))

function nextUpdate(sessionID: string, predicate: (event: ExecutionSchema.Summary) => boolean) {
  const release = ExecutionService.subscribe(sessionID)
  let dispose = () => {}
  const result = new Promise<{ type: string; properties: z.infer<typeof ExecutionSchema.Updated.properties> }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        dispose()
        reject(new Error("Execution update did not arrive after the coalescing interval"))
      }, 5000)
      const unsubscribe = Bus.subscribeGlobal(ExecutionSchema.Updated, (event) => {
        if (event.properties.sessionID !== sessionID || !predicate(event.properties.summary)) return
        dispose()
        resolve(event)
      })
      dispose = () => {
        clearTimeout(timer)
        unsubscribe()
        release()
      }
    },
  )
  return { result, dispose: () => dispose() }
}

test("unsubscribed execution caches do no scheduled presentation work and the last lease cancels refresh", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID }) => {
      await ExecutionService.summary(session.id)
      let updates = 0
      const off = Bus.subscribeGlobal(ExecutionSchema.Updated, (event) => {
        if (event.properties.sessionID === session.id) updates++
      })
      try {
        await Session.update(session.id, (info) => {
          info.title = "Unsubscribed"
        })
        await Bun.sleep(850)
        expect(updates).toBe(0)
        const release = ExecutionService.subscribe(session.id)
        await ExecutionService.summary(session.id)
        await Session.update(session.id, (info) => {
          info.title = "Released"
        })
        release()
        await Bun.sleep(850)
        expect(updates).toBe(0)
        expect((await ExecutionService.summary(session.id)).sessionID).toBe(session.id)
      } finally {
        off()
      }
    }),
  ))

test("persisted delegation status updates the parent's cancellation controls without rollout changes", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID }) => {
      const child = await Session.create({
        parentID: session.id,
        cortex: {
          taskID: Identifier.ascending("cortex"),
          parentSessionID: session.id,
          parentMessageID: rootID,
          description: "Review",
          agent: "reviewer",
          status: "queued",
          startedAt: Date.now(),
          visibility: "hidden",
        },
      })
      const initial = await ExecutionService.summary(session.id)
      expect(initial.tasks.find((task) => task.sessionID === child.id)?.cortex?.status).toBe("queued")
      const updated = nextUpdate(session.id, (summary) =>
        summary.tasks.some((task) => task.sessionID === child.id && task.cortex?.status === "cancelled"),
      )
      try {
        await Session.update(child.id, (info) => {
          if (info.cortex) info.cortex.status = "cancelled"
        })
        const event = await updated.result
        expect(event.properties.revision).toBeGreaterThan(initial.revision)
        expect(event.properties.summary.tasks.find((task) => task.sessionID === child.id)?.cortex?.visibility).toBe(
          "hidden",
        )
      } finally {
        updated.dispose()
      }
    }),
  ))

test(
  "a missed call notification recovers committed evidence and keeps child completion live",
  () =>
    runtime.run(() =>
      fixture(async ({ session, rootID, call }) => {
        await complete(call)
        await RolloutLedger.finishRun(call.owner, rootID, "completed")
        const child = await Session.create({ parentID: session.id, title: "Retained child analysis" })
        const owner = { kind: "session" as const, scopeID: child.scope.id, sessionID: child.id }
        const childRun = Identifier.ascending("message")
        const segment = await RolloutLedger.beginSegment({
          owner,
          runID: childRun,
          input: {},
          parent: { owner: call.owner, runID: rootID, messageID: rootID },
        })
        await RolloutExecution.provide({ owner, runID: childRun }, () => RolloutExecution.start(segment))
        const initial = await ExecutionService.summary(session.id)
        expect(initial.status).toBe("running")
        expect(initial.elapsedActive).toBe(true)

        using reads = spyOn(MessageV2, "stream")
        const publish = Bus.publish
        let missed = 0
        const delivery = spyOn(Bus, "publish").mockImplementation(async (definition, properties) => {
          if (definition.type === RolloutEvents.Updated.type) {
            const event = RolloutEvents.Updated.properties.parse(properties)
            if (event.owner.kind === "session" && event.owner.sessionID === child.id && event.record.kind === "call") {
              missed++
              return
            }
          }
          await publish(definition, properties)
        })
        const running = nextUpdate(session.id, (summary) => summary.tasks[0]?.tokens.unknown === 1)
        try {
          const childCall = await RolloutLedger.beginCall({
            owner,
            runID: childRun,
            purpose: "analysis",
            model: call.model,
            request: {},
          })
          const recorder = RolloutTransportRecorder.create(childCall)
          const attemptID = crypto.randomUUID()
          await recorder.emit({
            type: "attempt-start",
            attemptID,
            url: "https://model.test/responses",
            method: "POST",
            mediaType: "application/json",
          })
          const recovered = await running.result
          expect(missed).toBe(1)
          expect(reads.mock.calls.filter(([input]) => input.sessionID === session.id)).toHaveLength(0)
          expect(reads.mock.calls.filter(([input]) => input.sessionID === child.id)).toHaveLength(1)
          expect(recovered.properties.revision).toBeGreaterThan(initial.revision)
          expect(recovered.properties.summary.tasks[0].status).toBe("running")
          expect(
            recovered.properties.upserts.some((node) => node.sessionID === child.id && node.kind === "model"),
          ).toBe(true)
          delivery.mockRestore()

          const completed = nextUpdate(
            session.id,
            (summary) =>
              summary.status === "completed" &&
              summary.tasks.some((task) => task.sessionID === child.id && task.status === "completed"),
          )
          try {
            await recorder.emit({ type: "attempt-end", attemptID, status: "completed" })
            await RolloutLedger.finishCall(owner, childRun, childCall.id, {
              status: "completed",
              sdkUsage: { inputTokens: 7, outputTokens: 3 },
            })
            await RolloutExecution.stop(segment)
            await RolloutLedger.finishSegment(segment, "completed")
            await RolloutLedger.finishRun(owner, childRun, "completed")
            const update = await completed.result
            expect(update.properties.revision).toBeGreaterThan(recovered.properties.revision)
            expect(update.properties.summary.tasks).toHaveLength(1)
            expect(update.properties.summary.tasks[0].status).toBe("completed")
            expect(
              update.properties.upserts.some((node) => node.kind === "subtask" && node.status === "completed"),
            ).toBe(true)
          } finally {
            completed.dispose()
          }
        } finally {
          running.dispose()
          delivery.mockRestore()
        }
      }),
    ),
  15000,
)

test("inbox changes during initial loading and after caching converge through execution updates", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      await complete(call)
      await RolloutLedger.finishRun(call.owner, rootID, "completed")
      const first = await SessionInbox.enqueueUser({ sessionID: session.id, parts: [{ type: "text", text: "queued" }] })
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const list = SessionInbox.list
      let held = false
      const read = spyOn(SessionInbox, "list").mockImplementation(async (sessionID) => {
        const items = await list(sessionID)
        if (sessionID === session.id && !held) {
          held = true
          entered.resolve()
          await release.promise
        }
        return items
      })
      const pending = ExecutionService.summary(session.id)
      try {
        await entered.promise
        await SessionInbox.remove({ sessionID: session.id, itemID: first.id })
        release.resolve()
        expect((await pending).status).toBe("completed")
        const queued = nextUpdate(session.id, (summary) => summary.status === "queued")
        const item = await SessionInbox.enqueueUser({ sessionID: session.id, parts: [{ type: "text", text: "later" }] })
        try {
          expect((await queued.result).properties.summary.elapsedActive).toBe(false)
          const removed = nextUpdate(session.id, (summary) => summary.status === "completed")
          try {
            await SessionInbox.remove({ sessionID: session.id, itemID: item.id })
            expect((await removed.result).properties.summary.elapsedActive).toBe(false)
          } finally {
            removed.dispose()
          }
        } finally {
          queued.dispose()
        }
      } finally {
        release.resolve()
        await pending
        read.mockRestore()
      }
    }),
  ))
