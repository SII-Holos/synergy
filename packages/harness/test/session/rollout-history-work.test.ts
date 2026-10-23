import { afterAll, expect, spyOn, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import { RolloutLifecycle } from "../../src/session/rollout/lifecycle"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutEvidence } from "../../src/session/rollout/evidence"
import { fixture } from "../support/rollout"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("starting a production segment records its input without reading previous history", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      const root = await MessageV2.get({ sessionID: session.id, messageID: rootID })
      if (root.info.role !== "user") throw new Error("Expected root input")
      using history = spyOn(MessageV2, "stream").mockImplementation(() => {
        throw new Error("Run bookkeeping must not read historical bodies")
      })
      const segment = await RolloutLifecycle.start(session, root.info, root.parts)
      const run = await RolloutLedger.getRun(call.owner, rootID)
      expect(segment.status).toBe("running")
      expect(run.initialHistory).toBeUndefined()
      expect(RolloutEvidence.sources({ kind: "run", value: run }).map((source) => source.field)).toEqual(["input"])
      expect((await RolloutLedger.getCall(call.owner, rootID, call.id)).request.status).toBe("complete")
      expect(history).not.toHaveBeenCalled()
      await RolloutLifecycle.finishSegment(segment, "completed")
    }),
  ))
