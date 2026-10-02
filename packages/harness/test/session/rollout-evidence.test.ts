import { afterAll, expect, spyOn, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { fixture } from "../support/rollout"
import { RolloutEvidence } from "../../src/session/rollout/evidence"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { Bus } from "../../src/bus"
import { RolloutEvents } from "../../src/session/rollout/events"
import { Storage } from "../../src/storage/storage"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("a late content range reads only the intersecting blobs", () =>
  runtime.run(() =>
    fixture(async ({ call }) => {
      const writer = await RolloutArtifact.open(call.owner, "text/plain")
      for (let index = 0; index < 24; index++) {
        await writer.append(new TextEncoder().encode("x".repeat(65_536)))
        await writer.checkpoint()
      }
      const ref = await writer.finish()
      const read = spyOn(Storage, "readBinary")
      try {
        const bytes = await RolloutArtifact.readRange(call.owner, ref, ref.bytes - 128, 128)
        expect(new TextDecoder().decode(bytes)).toBe("x".repeat(128))
        expect(read.mock.calls.length).toBe(1)
      } finally {
        read.mockRestore()
      }
    }),
  ))

test("a content version preserves a partial prefix while its source grows", () =>
  runtime.run(() =>
    fixture(async ({ call }) => {
      const writer = await RolloutArtifact.open(call.owner, "text/plain")
      await writer.append(new TextEncoder().encode("中文 prefix"))
      const firstRef = await writer.checkpoint()
      await RolloutLedger.finishCall(call.owner, call.runID, call.id, { status: "completed", response: firstRef })
      const firstRecord = await RolloutEvidence.record(call.owner, call.runID, "call", call.id)
      const first = await RolloutEvidence.content(call.owner, firstRecord, "response", 0, 3)
      await writer.append(new TextEncoder().encode(" appended"))
      const finalRef = await writer.finish()
      await RolloutLedger.finishCall(call.owner, call.runID, call.id, { status: "completed", response: finalRef })
      const record = await RolloutEvidence.record(call.owner, call.runID, "call", call.id)
      const rest = await RolloutEvidence.content(
        call.owner,
        record,
        "response",
        first.nextOffset!,
        65_536,
        first.contentVersion,
      )
      expect(first.text + rest.text).toBe("中文 prefix")
      expect(rest.bytes).toBe(firstRef.bytes)
      expect(rest.status).toBe("partial")
      expect((await RolloutEvidence.content(call.owner, record, "response")).contentVersion).not.toBe(
        first.contentVersion,
      )
    }),
  ))

test("execution content pages preserve UTF-8 boundaries and read only a record's own references", () =>
  runtime.run(() =>
    fixture(async ({ call }) => {
      const text = "a".repeat(65_535) + "中文" + "b".repeat(70_000)
      const ref = await RolloutArtifact.writeText(call.owner, text)
      await RolloutLedger.finishCall(call.owner, call.runID, call.id, { status: "completed", response: ref })
      const record = await RolloutEvidence.record(call.owner, call.runID, "call", call.id)
      const first = await RolloutEvidence.content(call.owner, record, "response")
      const second = await RolloutEvidence.content(call.owner, record, "response", first.nextOffset!)
      const third = await RolloutEvidence.content(call.owner, record, "response", second.nextOffset!)
      expect(first.text + second.text + third.text).toBe(text)
      expect(first.nextOffset).toBe(65_535)
      expect(third.nextOffset).toBeNull()
      const small = await RolloutEvidence.content(call.owner, record, "response", first.nextOffset!, 1)
      expect(small.text).toBe("中")
      expect(small.nextOffset).toBe(first.nextOffset! + 3)
      await expect(RolloutEvidence.content(call.owner, record, "response", first.nextOffset! + 1)).rejects.toThrow()
      await expect(RolloutEvidence.content(call.owner, record, "credentials")).rejects.toThrow()
      await expect(RolloutEvidence.content({ ...call.owner, scopeID: "other" }, record, "response")).rejects.toThrow()
    }),
  ))

test("a notification failure preserves committed execution evidence", () =>
  runtime.run(() =>
    fixture(async ({ call }) => {
      const publish = Bus.publish
      const notification = spyOn(Bus, "publish").mockImplementation((definition, properties, ...options) =>
        definition.type === RolloutEvents.Updated.type
          ? Promise.reject(new Error("notification unavailable"))
          : publish(definition, properties, ...options),
      )
      try {
        await RolloutLedger.finishCall(call.owner, call.runID, call.id, { status: "cancelled" })
        expect((await RolloutLedger.getCall(call.owner, call.runID, call.id)).status).toBe("cancelled")
      } finally {
        notification.mockRestore()
      }
    }),
  ))
