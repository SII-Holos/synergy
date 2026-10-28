import { afterAll, expect, spyOn, test } from "bun:test"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { complete, fixture } from "@ericsanchezok/synergy-harness/test/support/rollout"
import { testRuntime } from "../support/runtime"
import { ExecutionService } from "../../src/execution/service"
import { ExecutionSchema } from "../../src/execution/schema"
import { RolloutExecution, RolloutSnapshot } from "@ericsanchezok/synergy-harness/rollout"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { Usage } from "@ericsanchezok/synergy-harness/usage"
import { ExecutionActivity } from "../../src/execution/activity"
import { ExecutionProcess } from "../../src/execution/process"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("unchanged summary reads and trajectory pages reuse static projections", () =>
  runtime.run(() =>
    fixture(async ({ session }) => {
      const before = await ExecutionService.summary(session.id)
      const first = await ExecutionService.trajectory(session.id, ExecutionSchema.Query.parse({ limit: 1 }))
      expect(first.nextCursor).not.toBeNull()
      using usage = spyOn(Usage, "summarize")
      using activity = spyOn(ExecutionActivity, "project")
      using process = spyOn(ExecutionProcess, "project")
      const summary = await ExecutionService.summary(session.id)
      const next = await ExecutionService.trajectory(
        session.id,
        ExecutionSchema.Query.parse({ limit: 1, cursor: first.nextCursor }),
      )
      expect(summary.revision).toBe(before.revision)
      expect(summary.accounting).toEqual(before.accounting)
      expect(next.items).toHaveLength(1)
      expect(next.items[0].id).not.toBe(first.items[0].id)
      expect(usage).not.toHaveBeenCalled()
      expect(activity).not.toHaveBeenCalled()
      expect(process).not.toHaveBeenCalled()
    }),
  ))

test("current statistics and trajectory do not wait for historical journal verification", () =>
  runtime.run(() =>
    fixture(async ({ session }) => {
      using replay = spyOn(RolloutSnapshot, "currentAll").mockRejectedValue(new Error("historical audit unavailable"))
      const summary = await ExecutionService.summary(session.id)
      expect(summary.coverage.gaps).toBeNull()
      const page = await ExecutionService.trajectory(session.id, ExecutionSchema.Query.parse({ limit: 10 }))
      expect(page.items.length).toBeGreaterThan(0)
      expect(replay).not.toHaveBeenCalled()
    }),
  ))

test("returned root and round summaries cannot mutate their static preparation", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID }) => {
      for (const runID of [undefined, rootID]) {
        const first = await ExecutionService.summary(session.id, runID)
        const expected = structuredClone(first)
        first.coverage.partial = !first.coverage.partial
        first.accounting.calls = -1
        first.status = "cancelled"
        const next = await ExecutionService.summary(session.id, runID)
        expect(next.coverage).toEqual(expected.coverage)
        expect(next.accounting).toEqual(expected.accounting)
        expect(next.status).toBe(expected.status)
      }
    }),
  ))

test("cached statistics resample canonical root, child and round clocks without aggregating usage", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      await complete(call)
      const segment = await RolloutLedger.beginSegment({ owner: call.owner, runID: rootID, input: {} })
      await RolloutExecution.provide({ owner: call.owner, runID: rootID }, () => RolloutExecution.start(segment))
      const child = await Session.create({ parentID: session.id, title: "Active child" })
      const owner = { kind: "session" as const, scopeID: child.scope.id, sessionID: child.id }
      const runID = Identifier.ascending("message")
      const childSegment = await RolloutLedger.beginSegment({
        owner,
        runID,
        input: {},
        parent: { owner: call.owner, runID: rootID, messageID: rootID },
      })
      await RolloutExecution.provide({ owner, runID }, () => RolloutExecution.start(childSegment))
      try {
        const sample = RolloutExecution.clock()
        using clock = spyOn(RolloutExecution, "clock").mockReturnValue(sample)
        const first = await ExecutionService.summary(session.id)
        const scoped = await ExecutionService.summary(session.id, rootID)
        using usage = spyOn(Usage, "summarize")
        clock.mockReturnValue({ ...sample, now: sample.now + 1000 })
        const later = await ExecutionService.summary(session.id)
        const laterScoped = await ExecutionService.summary(session.id, rootID)
        expect(later.revision).toBe(first.revision)
        expect(later.elapsedActive).toBe(true)
        expect(later.elapsedMs).toBe(first.elapsedMs! + 1000)
        expect(later.rounds.find((round) => round.id === rootID)?.elapsedMs).toBe(
          first.rounds.find((round) => round.id === rootID)!.elapsedMs! + 1000,
        )
        expect(laterScoped.elapsedMs).toBe(scoped.elapsedMs! + 1000)
        expect(later.tasks.find((task) => task.sessionID === child.id)?.elapsedMs).toBe(
          first.tasks.find((task) => task.sessionID === child.id)!.elapsedMs! + 1000,
        )
        expect(later.sampledAt).toBe(sample.now + 1000)
        expect(usage).not.toHaveBeenCalled()
      } finally {
        await RolloutExecution.stop(childSegment)
        await RolloutLedger.finishSegment(childSegment, "completed")
        await Session.remove(child.id)
        await RolloutExecution.stop(segment)
        await RolloutLedger.finishSegment(segment, "completed")
      }
    }),
  ))

test("journal verification is shared, cancellable and leaves current interactions available", () =>
  runtime.run(() =>
    fixture(async ({ session }) => {
      await ExecutionService.summary(session.id)
      const original = RolloutSnapshot.currentAll
      const reached = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      using audit = spyOn(RolloutSnapshot, "currentAll").mockImplementation(async (owners, signal) => {
        reached.resolve()
        await release.promise
        signal?.throwIfAborted()
        return original(owners, signal)
      })
      const controller = new AbortController()
      const first = ExecutionService.verifyJournal(session.id, controller.signal)
      const settled = first.catch((error: unknown) => error)
      await reached.promise
      const second = ExecutionService.verifyJournal(session.id)
      try {
        expect((await ExecutionService.summary(session.id)).coverage.gaps).toBeNull()
        expect(
          (await ExecutionService.trajectory(session.id, ExecutionSchema.Query.parse({ limit: 10 }))).items.length,
        ).toBeGreaterThan(0)
        controller.abort(new Error("view closed"))
        expect(await settled).toBeInstanceOf(Error)
      } finally {
        release.resolve()
      }
      await second
      expect(audit).toHaveBeenCalledTimes(1)
      expect((await ExecutionService.summary(session.id)).coverage.gaps).toBe(0)
    }),
  ))

test("message-only completion and accounting changes reproject compact facts", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      const messages = await Session.messages({ sessionID: session.id })
      const assistant = messages.find((message) => message.info.role === "assistant")!.info
      if (assistant.role !== "assistant") throw new Error("Expected assistant")
      const id = Identifier.ascending("part")
      const text = "  ".repeat(9000) + "kept preview ".repeat(1000)
      await Session.updatePartDelta(
        {
          id,
          messageID: assistant.id,
          sessionID: session.id,
          type: "reasoning",
          text,
          time: { start: assistant.time.created },
        },
        text,
      )
      await Session.flushPartWrites(session.id)
      using bodies = spyOn(MessageV2, "parts")
      using stream = spyOn(MessageV2, "stream")
      const before = await ExecutionService.summary(session.id)
      expect(before.coverage.messages).toBeGreaterThan(0)
      expect(bodies).not.toHaveBeenCalled()
      expect(stream).not.toHaveBeenCalled()
      using binary = spyOn(Storage, "readBinary")
      await Session.updateMessage({
        ...assistant,
        rootID,
        time: { ...assistant.time, completed: 12345 },
        error: new MessageV2.AbortedError({ message: "stopped" }).toObject(),
        accounting: { kind: "rollout", callIDs: [call.id] },
      })
      const page = await ExecutionService.trajectory(
        session.id,
        ExecutionSchema.Query.parse({ kind: "reasoning", mode: "records" }),
      )
      expect(page.items.find((node) => node.messageID === assistant.id)).toMatchObject({
        status: "failed",
        ended: 12345,
        preview: text.replace(/\s+/g, " ").slice(0, 240),
        parentID: Buffer.from(JSON.stringify([session.id, "call", call.id])).toString("base64url"),
      })
      expect(binary).not.toHaveBeenCalled()
      expect(bodies).not.toHaveBeenCalled()
    }),
  ))
