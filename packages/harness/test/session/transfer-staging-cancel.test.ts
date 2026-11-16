import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { Lock } from "../../src/util/lock"
import { SessionTransferStaging as Staging } from "../../src/session/transfer-staging"
import { Storage } from "../../src/storage/storage"

test("a cancelled target receive leaves its native lock queue before the prior receive releases", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const handoffID = "queued-target-receive"
    const held = await Lock.write("session-transfer-staging:" + handoffID)
    const controller = new AbortController()
    const reason = new Error("The target caller stopped receiving")
    const settled = Promise.withResolvers<{ kind: "settled"; error: unknown } | { kind: "waiting" }>()
    const work = Staging.receive({
      handoffID,
      root: {
        format: "synergy-portable-session",
        version: 2,
        complete: true,
        entries: 0,
        bytes: 0,
        pages: 0,
        head: null,
        owners: {},
      },
      signal: controller.signal,
      store: {
        async put() {
          throw new Error("Cancelled receive cannot publish bytes")
        },
        async get() {
          throw new Error("Cancelled receive cannot fetch bytes")
        },
      },
    }).then(
      () => settled.resolve({ kind: "settled", error: undefined }),
      (error) => settled.resolve({ kind: "settled", error }),
    )
    const rescue = setTimeout(() => settled.resolve({ kind: "waiting" }), 1000)
    try {
      controller.abort(reason)
      const result = await settled.promise
      expect(result.kind).toBe("settled")
      if (result.kind !== "settled") throw new Error("Cancelled receive remained queued behind another caller")
      expect(result.error).toBe(reason)
      await expect(Staging.inspect(handoffID)).rejects.toBeInstanceOf(Storage.NotFoundError)
    } finally {
      clearTimeout(rescue)
      held[Symbol.dispose]()
      await work
    }
  })
})
