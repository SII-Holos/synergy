import { afterAll, expect, spyOn, test } from "bun:test"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { fixture } from "@ericsanchezok/synergy-harness/test/support/rollout"
import { testRuntime } from "../support/runtime"
import { ExecutionService } from "../../src/execution/service"
import { ExecutionSchema } from "../../src/execution/schema"
import { RolloutSnapshot } from "@ericsanchezok/synergy-harness/rollout"

const runtime = await testRuntime()
afterAll(() => runtime.close())

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
