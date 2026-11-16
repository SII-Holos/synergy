import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { Environment } from "../../src/environment"
import { EnvironmentProviders } from "../../src/environment/provider"
import { RuntimeContext } from "../../src/lifecycle/context"
import { RuntimeMaintenance } from "../../src/storage/runtime-maintenance"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { StorageCommitUnknownError } from "../../src/storage/errors"
import {
  TransactionalStore,
  type StoreTransaction,
  type TransactionOptions,
} from "../../src/storage/transactional-store"
import { testEnvironmentRuntime } from "../support/environment-origin"
import { tmpdir } from "../support/fixture"

function fixture(home: string, effects: { allocate: number; deallocate: number; connect: number }) {
  return testEnvironmentRuntime({
    home,
    register() {
      RuntimeMaintenance.configure({ required: ["environments"] })
      Environment.registerRecovery({ allocation: "inspect-only" })
      EnvironmentProviders.register({
        id: "retained-admission",
        async allocate(request) {
          effects.allocate++
          return { id: request.requestID, capabilities: [] }
        },
        async inspect(request) {
          return { state: "ready", allocation: { id: request.requestID, capabilities: [] } }
        },
        async deallocate() {
          effects.deallocate++
        },
        async connect() {
          effects.connect++
          throw new Error("Admission retirement must not open a native executor")
        },
      })
    },
  })
}

async function retained(home: string, effects: Parameters<typeof fixture>[1]) {
  const original = await fixture(home, effects)
  try {
    return await original.run(async () => {
      const environment = await Environment.bind({
        scopeID: "scope",
        ownerID: "original",
        provider: "retained-admission",
        spec: {},
      })
      const lease = await Environment.acquire(environment.id, {
        scopeID: "scope",
        useID: "original-admission",
        capabilities: [],
        ownership: original.origin("original-invocation"),
      })
      await expect(Environment.retireRecoveredAdmission(lease.use, "scope")).rejects.toBeInstanceOf(
        Environment.Unavailable,
      )
      expect(await Environment.uses(environment.id)).toEqual([lease.use])
      return { use: structuredClone(lease.use), runtimeID: RuntimeContext.current().id }
    })
  } finally {
    await original.close()
  }
}

test("cold admission retirement consumes only its exact original Use in the actual primary without native effects", async () => {
  await using directory = await tmpdir()
  const effects = { allocate: 0, deallocate: 0, connect: 0 }
  const original = await retained(directory.path, effects)
  await using cold = await fixture(directory.path, effects)
  await cold.run(async () => {
    expect(RuntimeContext.current().id).not.toBe(original.runtimeID)
    expect(await Environment.uses(original.use.target.environmentID)).toEqual([original.use])
    const before = structuredClone(effects)
    await expect(
      Environment.retireRecoveredAdmission({ ...original.use, createdAt: original.use.createdAt + 1 }, "scope"),
    ).rejects.toBeInstanceOf(Environment.Busy)
    await expect(Environment.retireRecoveredAdmission(original.use, "another-scope")).rejects.toBeInstanceOf(
      Storage.NotFoundError,
    )
    const foreign = await TransactionalStore.open({
      backend: "sqlite",
      filename: path.join(cold.host.root, "foreign-admission.sqlite"),
      namespace: "foreign",
    })
    try {
      await Storage.provide(
        { store: foreign, artifactDirectory: path.join(cold.host.root, "foreign-artifacts") },
        async () => {
          await expect(Environment.retireRecoveredAdmission(original.use, "scope")).rejects.toBeInstanceOf(
            Environment.Unavailable,
          )
          expect(await Storage.count({ prefix: ["environment_use"] })).toBe(0)
        },
      )
    } finally {
      await foreign.close()
    }
    expect(await Environment.uses(original.use.target.environmentID)).toEqual([original.use])
    await Environment.retireRecoveredAdmission(original.use, "scope")
    expect(await Environment.uses(original.use.target.environmentID)).toEqual([])
    const completed = await Environment.get(original.use.target.environmentID, "scope")
    expect(completed.state).toBe("ready")
    await Environment.retireRecoveredAdmission(original.use, "scope")
    expect(await Environment.get(original.use.target.environmentID, "scope")).toEqual(completed)
    expect(effects).toEqual(before)
    expect(effects).toEqual({ allocate: 1, deallocate: 0, connect: 0 })
  })
})

test("a lost committed admission-retirement acknowledgement preserves exact idempotent cold completion", async () => {
  await using directory = await tmpdir()
  const effects = { allocate: 0, deallocate: 0, connect: 0 }
  const original = await retained(directory.path, effects)
  await using cold = await fixture(directory.path, effects)
  await cold.run(async () => {
    expect(await Environment.uses(original.use.target.environmentID)).toEqual([original.use])
    const store = Storage.current().store
    const transaction = store.transaction.bind(store)
    let lost = false
    using fault = spyOn(store, "transaction").mockImplementation(
      async <T>(body: (tx: StoreTransaction) => Promise<T>, options?: TransactionOptions) => {
        const result = await transaction(body, options)
        const [row] = await store.readMany([
          StoragePath.environmentUse(original.use.target.environmentID, original.use.id),
        ])
        if (!lost && row === undefined) {
          lost = true
          throw new StorageCommitUnknownError(
            options?.operationID ?? "retained-admission-retirement",
            new Error("The original committed acknowledgement was lost"),
          )
        }
        return result
      },
    )
    await expect(Environment.retireRecoveredAdmission(original.use, "scope")).rejects.toBeInstanceOf(
      StorageCommitUnknownError,
    )
    expect(lost).toBe(true)
    expect(await Environment.uses(original.use.target.environmentID)).toEqual([])
    const completed = await Environment.get(original.use.target.environmentID, "scope")
    await Environment.retireRecoveredAdmission(original.use, "scope")
    expect(await Environment.get(original.use.target.environmentID, "scope")).toEqual(completed)
    expect(effects).toEqual({ allocate: 1, deallocate: 0, connect: 0 })
  })
})
