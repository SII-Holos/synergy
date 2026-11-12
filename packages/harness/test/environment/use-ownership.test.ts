import { expect, spyOn, test } from "bun:test"
import { Environment } from "../../src/environment"
import { EnvironmentExecution } from "../../src/environment/execution"
import { EnvironmentProviders } from "../../src/environment/provider"
import type { ExecutionProtocol, Executor } from "../../src/environment/executor"
import { testEnvironmentRuntime } from "../support/environment-origin"
import { RuntimeMaintenance } from "../../src/storage/runtime-maintenance"
import { EnvironmentSchema } from "../../src/environment/schema"
import { environmentUsePhysicalMigration } from "../../src/environment/use-migration"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { StorageCommitUnknownError } from "../../src/storage/errors"
import {
  TransactionalStore,
  type StoreTransaction,
  type TransactionOptions,
} from "../../src/storage/transactional-store"
import path from "node:path"
import { StorageRecovery } from "../../src/storage/recovery"
import { tmpdir } from "../support/fixture"

async function fixture(home?: string) {
  const statuses = new Map<string, ExecutionProtocol.Status>()
  const executor: Executor = {
    async start(request) {
      const status: ExecutionProtocol.Status = {
        id: request.id,
        target: request.target,
        digest: request.digest,
        state: "running",
        cursor: 0,
        treeDrained: false,
        streamsDrained: false,
      }
      statuses.set(request.id, status)
      return status
    },
    async status(id) {
      return statuses.get(id)
    },
    async output() {
      return []
    },
    async cancel(id, digest) {
      const original = statuses.get(id)
      if (!original || original.digest !== digest) throw new Error("The original execution receipt is required")
      statuses.set(id, {
        ...original,
        state: "cancelled",
        effectsStarted: true,
        treeDrained: true,
        streamsDrained: true,
      })
    },
    async stdin() {},
    async resize() {},
    async release() {},
  }
  return testEnvironmentRuntime({
    home,
    register() {
      RuntimeMaintenance.configure({ required: ["environments"] })
      EnvironmentProviders.register({
        id: "use-owner",
        async allocate(request) {
          return { id: request.requestID, capabilities: ["exec"] }
        },
        async inspect(request) {
          return { state: "ready", allocation: { id: request.requestID, capabilities: ["exec"] } }
        },
        async deallocate() {},
        async connect() {
          return executor
        },
      })
    },
  })
}

for (const family of ["admission", "execution-preparation"] as const)
  for (const mode of ["current", "cold"] as const)
    test(`${mode} recovery cannot discard ${family} whose persisted origin is unknown`, async () => {
      await using directory = await tmpdir()
      const first = await fixture(directory.path)
      const state = await first.run(async () => {
        const environment = await Environment.bind({
          scopeID: "scope",
          ownerID: "owner",
          provider: "use-owner",
          spec: {},
        })
        const lease = await Environment.acquire(environment.id, {
          scopeID: "scope",
          useID: "prepare",
          capabilities: [],
          ownership: first.origin("prepare"),
        })
        await lease.release()
        const key = StoragePath.environmentUse(environment.id, "unknown-origin")
        const record = {
          schemaVersion: 2,
          use: {
            id: "unknown-origin",
            target: lease.target,
            createdAt: 1,
            kind: "admission",
            ownerEpoch: "previous-runtime",
            ownership:
              family === "admission"
                ? { kind: "admission", origin: { kind: "legacy-unknown" } }
                : {
                    kind: "execution-preparation",
                    scopeID: "scope",
                    operationID: "unrecorded",
                    origin: { kind: "legacy-unknown" },
                  },
          },
        }
        await Storage.write(key, record)
        return { key, record, options: { ...Storage.current().store.options } }
      })
      if (mode === "current") {
        try {
          await first.run(async () => {
            const result = await StorageRecovery.recoverOwners().then(
              () => ({ rejected: false }),
              () => ({ rejected: true }),
            )
            expect(await Storage.current().store.readMany([state.key])).toEqual([state.record])
            expect(result.rejected).toBeTrue()
          })
        } finally {
          await first.close()
        }
        return
      }
      await first.close()
      const result = await fixture(directory.path).then(
        (runtime) => ({ runtime }),
        (error: unknown) => ({ error }),
      )
      if ("runtime" in result) await result.runtime.close()
      try {
        const stored = await TransactionalStore.open(state.options)
        try {
          expect(await stored.readMany([state.key])).toEqual([state.record])
        } finally {
          await stored.close()
        }
        expect(result).toHaveProperty("error")
      } finally {
        if ("runtime" in result) await result.runtime.close()
      }
    }, 15_000)

test.each(["another-invocation", "original-invocation"])(
  "an admission from %s cannot replace a retained execution Use",
  async (invocation) => {
    await using runtime = await fixture()
    await runtime.run(async () => {
      const environment = await Environment.bind({
        scopeID: "scope",
        ownerID: "owner",
        provider: "use-owner",
        spec: {},
      })
      const operation = await EnvironmentExecution.start({
        id: "original",
        scopeID: "scope",
        environmentID: environment.id,
        origin: runtime.origin("original-invocation"),
        command: { command: "fixture", args: [], cwd: "/workspace", env: {}, useRoots: [] },
      })
      const original = (await Environment.uses(environment.id))[0]
      if (!original) throw new Error("The running execution must retain its actual native Use")
      expect(original.kind).toBe("operation")
      const input = {
        scopeID: "scope",
        useID: original.id,
        capabilities: ["exec"],
        kind: "admission" as const,
        ownership: runtime.origin(invocation),
      }
      const result = await Environment.acquire(environment.id, input).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      try {
        expect(result).toHaveProperty("error")
        expect(await Environment.uses(environment.id)).toEqual([original])
        await expect(Environment.deallocate(environment.id, { scopeID: "scope" })).rejects.toBeInstanceOf(
          Environment.Busy,
        )
        expect((await EnvironmentExecution.get(operation.id, operation.scopeID)).state).toBe("running")
      } finally {
        if ("value" in result) await result.value.release()
        await EnvironmentExecution.cancel(operation.id, operation.scopeID)
        await EnvironmentExecution.complete(operation.id, operation.scopeID)
      }
    })
  },
)

test("an already ready Environment rejects a new Use while its native Home is held", async () => {
  await using runtime = await fixture()
  await runtime.run(async () => {
    const environment = await Environment.bind({ scopeID: "scope", ownerID: "owner", provider: "use-owner", spec: {} })
    await (
      await Environment.acquire(environment.id, {
        scopeID: "scope",
        useID: "warm",
        capabilities: [],
        ownership: runtime.origin("warm"),
      })
    ).release()
    const lease = await RuntimeMaintenance.begin({
      purpose: "organization-backup",
      requestID: "use-hold",
      actor: {
        kind: "system",
        subjectID: "operator",
        displayName: "Host operator",
        clientKind: "system",
        requestID: "use-hold",
      },
    })
    let admitted: Awaited<ReturnType<typeof Environment.acquire>> | undefined
    try {
      await expect(
        Environment.acquire(environment.id, {
          scopeID: "scope",
          useID: "new",
          capabilities: [],
          ownership: runtime.origin("new"),
        }).then((value) => {
          admitted = value
          return value
        }),
      ).rejects.toBeInstanceOf(RuntimeMaintenance.Blocked)
      expect(await Environment.uses(environment.id)).toEqual([])
    } finally {
      await admitted?.release()
      await RuntimeMaintenance.release(lease)
    }
  })
})

test("physical Use migration preserves original unknown owners beyond a page and refuses old readers", async () => {
  await using runtime = await fixture()
  await runtime.run(async () => {
    const environment = await Environment.bind({ scopeID: "scope", ownerID: "owner", provider: "use-owner", spec: {} })
    const admission = await Environment.acquire(environment.id, {
      scopeID: "scope",
      useID: "warm",
      capabilities: [],
      ownership: runtime.origin("migration"),
    })
    const stored = await Storage.current().store.read(StoragePath.environmentUse(environment.id, "warm"))
    expect(EnvironmentSchema.LegacyUse.safeParse(stored).success).toBeFalse()
    await admission.release()
    for (let index = 0; index < 130; index++) {
      const id = `old-${index.toString().padStart(3, "0")}`
      await Storage.write(StoragePath.environmentUse(environment.id, id), {
        id,
        target: { ...admission.target, futureTarget: "retain" },
        kind: "operation",
        createdAt: 1,
        futureOwner: { retained: true },
      })
    }
    await environmentUsePhysicalMigration.up(() => {})
    expect(await Environment.uses(environment.id)).toHaveLength(130)
    const original = await Storage.current().store.read(StoragePath.environmentUse(environment.id, "old-129"))
    expect(original).toMatchObject({
      schemaVersion: 2,
      use: {
        ownership: { kind: "legacy-unknown" },
        futureOwner: { retained: true },
        target: { futureTarget: "retain" },
      },
    })
    expect(EnvironmentSchema.LegacyUse.safeParse(original).success).toBeFalse()
    const lease = await RuntimeMaintenance.begin({
      purpose: "organization-backup",
      requestID: "unknown-use",
      actor: {
        kind: "system",
        subjectID: "operator",
        displayName: "Host operator",
        clientKind: "system",
        requestID: "unknown-use",
      },
    })
    try {
      await expect(RuntimeMaintenance.drain(lease)).rejects.toMatchObject({
        name: "RuntimeMaintenanceBlocked",
        data: { requirements: [{ owner: "environments", code: "environment_use_unknown" }] },
      })
      expect(await Environment.uses(environment.id)).toHaveLength(130)
    } finally {
      await expect(RuntimeMaintenance.release(lease)).rejects.toBeInstanceOf(RuntimeMaintenance.Blocked)
    }
  })
})

test("a live admission remains in the native maintenance cohort until its original lease releases", async () => {
  await using runtime = await fixture()
  await runtime.run(async () => {
    const environment = await Environment.bind({ scopeID: "scope", ownerID: "owner", provider: "use-owner", spec: {} })
    const admission = await Environment.acquire(environment.id, {
      scopeID: "scope",
      useID: "stream",
      capabilities: [],
      ownership: runtime.origin("stream"),
    })
    const lease = await RuntimeMaintenance.begin({
      purpose: "organization-backup",
      requestID: "live-use",
      actor: {
        kind: "system",
        subjectID: "operator",
        displayName: "Host operator",
        clientKind: "system",
        requestID: "live-use",
      },
    })
    try {
      await expect(RuntimeMaintenance.drain(lease)).rejects.toBeInstanceOf(RuntimeMaintenance.Blocked)
      await admission.release()
      await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
      expect(await Environment.uses(environment.id)).toEqual([])
    } finally {
      await admission.release()
      await RuntimeMaintenance.release(lease)
    }
  })
})

test("a lost canonical execution commit keeps its original retained Use instead of releasing an admission", async () => {
  await using runtime = await fixture()
  await runtime.run(async () => {
    const environment = await Environment.bind({ scopeID: "scope", ownerID: "owner", provider: "use-owner", spec: {} })
    const store = Storage.current().store
    const transaction = store.transaction.bind(store)
    let lost = false
    using fault = spyOn(store, "transaction").mockImplementation(
      async <T>(body: (tx: StoreTransaction) => Promise<T>, options?: TransactionOptions) => {
        const result = await transaction(body, options)
        const [record] = await store.readMany<{ schemaVersion: number; execution: { state: string } }>([
          StoragePath.environmentExecution("scope", "unconfirmed"),
        ])
        if (!lost && record?.execution.state === "submitted") {
          lost = true
          throw new StorageCommitUnknownError(
            options?.operationID ?? "execution-use-fixture",
            new Error("Original commit acknowledgement was lost"),
          )
        }
        return result
      },
    )
    await expect(
      EnvironmentExecution.start({
        id: "unconfirmed",
        scopeID: "scope",
        environmentID: environment.id,
        origin: runtime.origin("unconfirmed"),
        command: { command: "fixture", args: [], cwd: "/workspace", env: {}, useRoots: [] },
      }),
    ).rejects.toBeInstanceOf(StorageCommitUnknownError)
    expect(lost).toBeTrue()
    const held = await Environment.uses(environment.id)
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({
      kind: "operation",
      ownership: { kind: "execution", scopeID: "scope", operationID: "unconfirmed" },
    })
    await expect(
      Environment.acquire(environment.id, {
        scopeID: "scope",
        useID: held[0]!.id,
        capabilities: [],
        ownership: runtime.origin("unconfirmed"),
      }),
    ).rejects.toBeInstanceOf(Environment.Busy)
    expect((await EnvironmentExecution.get("unconfirmed", "scope")).state).toBe("submitted")
    await expect(Environment.deallocate(environment.id, { scopeID: "scope" })).rejects.toBeInstanceOf(Environment.Busy)
  })
})

test("deferred Use reads and original admission cleanup reject another Store in the same Runtime", async () => {
  await using runtime = await fixture()
  await runtime.run(async () => {
    const environment = await Environment.bind({ scopeID: "scope", ownerID: "owner", provider: "use-owner", spec: {} })
    const admission = await Environment.acquire(environment.id, {
      scopeID: "scope",
      useID: "original",
      capabilities: [],
      ownership: runtime.origin("original"),
    })
    const iterator = Environment.useEntries(environment.id)[Symbol.asyncIterator]()
    const foreign = await TransactionalStore.open({
      backend: "sqlite",
      filename: path.join(runtime.host.root, "foreign-use.sqlite"),
      namespace: "foreign",
    })
    try {
      await Storage.provide(
        { store: foreign, artifactDirectory: path.join(runtime.host.root, "foreign-artifacts") },
        async () => {
          await expect(iterator.next()).rejects.toThrow("Storage configuration")
          await expect(admission.release()).rejects.toThrow("Storage handle")
          expect(await Storage.count({ prefix: ["environment_use"] })).toBe(0)
        },
      )
      expect(await Environment.uses(environment.id)).toHaveLength(1)
    } finally {
      await foreign.close()
      await admission.release()
    }
    expect(await Environment.uses(environment.id)).toEqual([])
  })
})
