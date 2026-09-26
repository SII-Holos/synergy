import { describe, expect, spyOn, test } from "bun:test"
import { RolloutCall } from "../../src/session/rollout/call"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { StorageBusyError } from "../../src/storage/errors"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionRetry } from "../../src/session/retry"
import { Storage } from "../../src/storage/storage"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

function input() {
  const id = crypto.randomUUID()
  return {
    owner: { kind: "operation" as const, scopeID: "test", operationID: id },
    runID: id,
    purpose: "test",
    model: { providerID: "test", modelID: "test", sdk: "test", pricing: null },
    request: { messages: [] },
  }
}

describe("transient storage pressure during rollout recording", () => {
  test("keeps the run retryable instead of disqualifying its recording", () =>
    runtime.run(async () => {
      const args = input()
      {
        using write = spyOn(Storage, "writeBinary").mockRejectedValue(
          new StorageBusyError("Authoritative storage admission deadline exceeded"),
        )
        await expect(
          RolloutCall.stream(args, async () => {
            throw new Error("must not execute")
          }),
        ).rejects.toBeInstanceOf(StorageBusyError)
      }
      expect((await RolloutLedger.getRun(args.owner, args.runID)).recording).not.toBe("failed")
      expect((await RolloutLedger.beginCall(args)).status).toBe("running")
    }))

  test("leaves the turn inside its retry budget rather than terminal", () =>
    runtime.run(async () => {
      const args = input()
      let failure: unknown
      {
        using write = spyOn(Storage, "writeBinary").mockRejectedValue(
          new StorageBusyError("Authoritative storage admission deadline exceeded"),
        )
        failure = await RolloutCall.stream(args, async () => {
          throw new Error("must not execute")
        }).catch((error: unknown) => error)
      }
      expect(SessionRetry.retryable(MessageV2.fromError(failure, { providerID: "test" }))).toBeDefined()
    }))
})

afterRuntimeTests(() => runtime.close())
