import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { AsyncLocalStorage } from "node:async_hooks"
import { z } from "zod"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import { StorageQueue, storageQueueSignal } from "@ericsanchezok/synergy-harness/storage/queue"
import type { StoreTransaction, TransactionOptions } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { OrganizationSourceRetirement as Retirement } from "../../src/backup/source-retirement"
import { OrganizationCurrentAuthority as Current } from "../../src/backup/current-authority"
import { openOrganizationPendingRetirement, openOrganizationSourceRetirement } from "../../src/service"
import { pendingKeys, withPendingTarget } from "../support/pending-retirement-child"

async function original() {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "retirement-commit-")))
  try {
    const child = Bun.spawn([process.execPath, "./test/support/pending-retirement-child.ts"], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdout: "ignore",
      stderr: "pipe",
      env: { ...process.env, SYNERGY_PENDING_RETIREMENT_DIRECTORY: directory },
    })
    const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()])
    if (exit !== 0) throw new Error(error)
    const selected = z
      .object({ home: z.string(), reference: Retirement.Reference })
      .parse(await Bun.file(path.join(directory, "selector.json")).json())
    const source = await openOrganizationPendingRetirement(selected)
    const namespace = {
      directory: path.join(directory, "h1", "records"),
      expected: StorageCheckpoint.Manifest.parse(
        await Bun.file(path.join(directory, "h1", "records", "manifest.json")).json(),
      ),
    }
    const native = {
      directory: path.join(directory, "h1", "native"),
      expected: StorageCheckpoint.Manifest.parse(
        await Bun.file(path.join(directory, "h1", "native", "manifest.json")).json(),
      ),
    }
    return {
      directory,
      source,
      reference: selected.reference,
      home: selected.home,
      namespace,
      native,
      async [Symbol.asyncDispose]() {
        try {
          await source.close()
        } finally {
          await fs.rm(directory, { recursive: true, force: true })
        }
      },
    }
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true })
    throw error
  }
}

for (const phase of ["before", "after"] as const)
  test(`retirement commit unknown ${phase} SQL publication preserves actual acceptance and observer scope`, async () => {
    await using f = await original()
    const store = await f.source.run(async () => Storage.current().store)
    const transaction = store.transaction.bind(store)
    const unknown = new Storage.CommitUnknownError(
      "source-retirement",
      new Error("Original retirement acknowledgement unknown"),
    )
    const controller = new AbortController()
    const observer = new Error("Observer left after the original SQL commit")
    let injected = false
    using fault = spyOn(store, "transaction").mockImplementation(
      async <T>(body: (tx: StoreTransaction) => Promise<T>, options?: TransactionOptions) => {
        if (!injected && phase === "before") {
          injected = true
          throw unknown
        }
        const result = await transaction(body, options)
        if (
          !injected &&
          z.object({ source: RuntimeMaintenance.Info, referenceHash: z.string() }).safeParse(result).success
        ) {
          injected = true
          controller.abort(observer)
          throw unknown
        }
        return result
      },
    )
    const complete = Retirement.complete
    using completion = spyOn(Retirement, "complete").mockImplementation((reference) => complete(reference))
    const commit = RuntimeMaintenance.withRetirementCommit
    let escaped: (() => Promise<boolean>) | undefined
    using scope = spyOn(RuntimeMaintenance, "withRetirementCommit").mockImplementationOnce(
      async <T>(input: Parameters<typeof commit>[0], body: () => Promise<T>) => {
        await expect(commit({ ...input, lease: { ...input.lease } }, body)).rejects.toBeInstanceOf(
          RuntimeMaintenance.Blocked,
        )
        await expect(commit({ ...input, referenceHash: "f".repeat(64) }, body)).rejects.toBeInstanceOf(
          RuntimeMaintenance.Blocked,
        )
        const result = await commit(input, async () => {
          expect(storageQueueSignal()).toBeUndefined()
          escaped = AsyncLocalStorage.bind(() => new StorageQueue("expired-retirement-tail").run(async () => true))
          return body()
        })
        if (phase === "after") {
          expect(storageQueueSignal()?.aborted).toBe(true)
          await expect(new StorageQueue("original-observer").run(async () => true)).rejects.toBe(observer)
          if (!escaped) throw new Error("The accepted native tail did not run")
          await expect(escaped()).rejects.toBeInstanceOf(RuntimeMaintenance.Blocked)
        }
        return result
      },
    )
    await withPendingTarget(f.directory, async (_target, _reference, target) => {
      const work = Current.resumeRetirement({
        source: f.source.source,
        target,
        namespace: f.namespace,
        native: f.native,
        keys: pendingKeys,
        signal: controller.signal,
      })
      if (phase === "before") {
        await expect(work).rejects.toBe(unknown)
        expect(completion).not.toHaveBeenCalled()
        expect(
          await f.source.run(() => RuntimeMaintenance.retirement(f.reference.current.maintenance.maintenanceID)),
        ).toBeUndefined()
        expect((await Bun.file(path.join(f.home, ".synergy", "home-ownership.json")).json()).schemaVersion).toBe(2)
      } else {
        const receipt = await work
        expect(await f.source.run(async () => Retirement.describe(receipt))).toEqual(f.reference)
        expect((await Bun.file(path.join(f.home, ".synergy", "home-ownership.json")).json()).schemaVersion).toBe(4)
      }
    })
    expect(injected).toBe(true)
  }, 30_000)

test("an accepted retirement native failure remains an error and retains the same cold completion", async () => {
  await using f = await original()
  const failure = new Error("The actual native retirement failed")
  using effect = spyOn(Retirement, "complete").mockImplementationOnce(async () => {
    throw failure
  })
  await withPendingTarget(f.directory, async (_target, _reference, target) => {
    await expect(
      Current.resumeRetirement({
        source: f.source.source,
        target,
        namespace: f.namespace,
        native: f.native,
        keys: pendingKeys,
      }),
    ).rejects.toBe(failure)
  })
  expect(
    await f.source.run(() => RuntimeMaintenance.retirement(f.reference.current.maintenance.maintenanceID)),
  ).toBeDefined()
  expect((await Bun.file(path.join(f.home, ".synergy", "home-ownership.json")).json()).schemaVersion).toBe(2)
  effect.mockRestore()
  await f.source.close()
  await using retry = await openOrganizationSourceRetirement({ home: f.home, reference: f.reference })
  const receipt = await retry.complete()
  expect(await retry.run(async () => Retirement.describe(receipt))).toEqual(f.reference)
  expect((await Bun.file(path.join(f.home, ".synergy", "home-ownership.json")).json()).schemaVersion).toBe(4)
}, 30_000)
