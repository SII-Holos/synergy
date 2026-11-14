import { expect, test } from "bun:test"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { StorageOwnershipError } from "../../src/storage/errors"
import { StorageMutationGuard } from "../../src/storage/mutation-guard"
import { StorageRetention } from "../../src/storage/retention"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"

const DAY = 24 * 60 * 60 * 1000

for (const rejection of ["permission", "unknown"] as const) {
  test(`automatic retention preserves native evidence when its original ${rejection} guard rejects pruning`, async () => {
    let protectedPrefix: string[] = []
    let guarded = 0
    const failure =
      rejection === "permission"
        ? new StorageOwnershipError("The original native evidence is retained")
        : new Error("The original native retention owner is unknown")
    await using runtime = await testRuntime({
      register() {
        StorageMutationGuard.register("retained-native-evidence", async (tx, keys, tree) => {
          if (
            !tree ||
            !protectedPrefix.length ||
            !keys.some(
              (key) =>
                key.length === protectedPrefix.length &&
                key.every((segment, index) => segment === protectedPrefix[index]),
            )
          )
            return
          expect(Storage.inWriteTransaction()).toBe(true)
          Storage.current().store.assertWriteTransaction(tx)
          expect(ScopeContext.current.scope.id).toBe(protectedPrefix[1])
          guarded++
          await tx.write(["test-retention-guard", "uncommitted"], { guarded })
          throw failure
        })
      },
    })
    await runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()
      await ScopeContext.provide({
        scope,
        workspace: null,
        async fn() {
          const retainedID = "ses_retained"
          protectedPrefix = ["sessions", scope.id, retainedID, "rollout"]
          const retainedKey = [...protectedPrefix, "runs", "run_original", "info"]
          await Storage.transaction(async (tx) => {
            await tx.write(["sessions", scope.id, retainedID, "info"], { id: retainedID })
            await tx.write(retainedKey, { native: "original", payload: "x".repeat(8192) })
          })
          const options = {
            retentionMs: 7 * DAY,
            maxBytes: 0,
            liveSessionIDs: [],
            now: Date.now() + 30 * DAY,
          }
          await expect(StorageRetention.run(options)).rejects.toBe(failure)
          expect(guarded).toBe(1)
          expect(await Storage.read(retainedKey)).toEqual({ native: "original", payload: "x".repeat(8192) })
          expect(await Storage.readMany([["test-retention-guard", "uncommitted"]])).toEqual([undefined])

          const eligibleID = "ses_eligible"
          const eligiblePrefix = ["sessions", scope.id, eligibleID, "rollout"]
          const eligibleKey = [...eligiblePrefix, "runs", "run_eligible", "info"]
          await Storage.transaction(async (tx) => {
            await tx.write(["sessions", scope.id, eligibleID, "info"], { id: eligibleID })
            await tx.write(eligibleKey, { native: "eligible", payload: "y".repeat(8192) })
          })
          const report = await StorageRetention.run({ ...options, liveSessionIDs: [retainedID] })
          expect(report.pruned.map((owner) => owner.key)).toEqual([eligiblePrefix])
          expect(report.protectedLive).toBe(1)
          expect(guarded).toBe(1)
          expect(await Storage.readMany([eligibleKey])).toEqual([undefined])
          expect(await Storage.read(retainedKey)).toMatchObject({ native: "original" })
          expect((await Storage.current().store.verify()).issues).toEqual([])
        },
      })
    })
  })
}
