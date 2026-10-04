import { expect, test } from "bun:test"
import { Environment } from "../../src/environment"
import { EnvironmentMaintenance } from "../../src/environment/maintenance"
import { EnvironmentProviders, type EnvironmentProvider } from "../../src/environment/provider"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { storageTestBackends } from "../support/storage-backends"
import { testRuntime } from "../support/runtime"

function bind() {
  return Environment.bind({ scopeID: "scope", ownerID: "session", provider: "held-provider", spec: {} })
}

function acquire(id: string) {
  return Environment.acquire(id, { scopeID: "scope", useID: "tool", capabilities: ["exec"] })
}

for (const backend of storageTestBackends()) {
  const open = (provider: EnvironmentProvider) =>
    testRuntime({
      postgres: backend === "postgres" ? process.env.SYNERGY_TEST_POSTGRES_URL : undefined,
      register: () => EnvironmentProviders.register(provider),
    })

  for (const [operation, inspection] of [
    ["allocate", "ready"],
    ["allocate", "pending"],
    ["deallocate", "ready"],
    ["deallocate", "absent"],
  ] as const) {
    test(`${backend}: maintenance preserves owned ${operation} when the provider reports ${inspection}`, async () => {
      const entered = Promise.withResolvers<void>()
      const finish = Promise.withResolvers<void>()
      let allocation: { id: string; capabilities: string[] } | undefined
      const calls = { inspect: 0, resume: 0, deallocate: 0 }
      const provider: EnvironmentProvider = {
        id: "held-provider",
        async allocate(request) {
          allocation = { id: request.requestID, capabilities: ["exec"] }
          if (operation === "allocate") {
            entered.resolve()
            await finish.promise
          }
          return allocation
        },
        async deallocate() {
          calls.deallocate++
          if (inspection === "absent") allocation = undefined
          entered.resolve()
          if (calls.deallocate === 1) await finish.promise
          allocation = undefined
        },
        async inspect() {
          calls.inspect++
          if (inspection === "pending") return { state: "pending" }
          return allocation ? { state: "ready", allocation } : { state: "absent" }
        },
        async resume() {
          calls.resume++
          return allocation!
        },
      }
      await using runtime = await open(provider)
      await runtime.run(async () => {
        const environment = await bind()
        const release = async () => {
          await (await acquire(environment.id)).release()
          return Environment.deallocate(environment.id, { scopeID: "scope" })
        }
        const pending = operation === "allocate" ? acquire(environment.id) : release()
        void pending.catch(() => {})
        try {
          await entered.promise
          await EnvironmentMaintenance.tick()
          finish.resolve()
          const result = await pending
          if ("release" in result) await result.release()
          expect(calls.inspect).toBe(0)
          expect(calls.resume).toBe(0)
          expect(calls.deallocate).toBe(operation === "allocate" ? 0 : 1)
          expect((await Environment.get(environment.id, "scope")).state).toBe(
            operation === "allocate" ? "ready" : "idle",
          )
        } finally {
          finish.resolve()
          await pending.catch(() => {})
        }
      })
    }, 30_000)
  }

  test(`${backend}: overlapping deallocation refuses a duplicate provider request`, async () => {
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    let deallocations = 0
    await using runtime = await open({
      id: "held-provider",
      async allocate(request) {
        return { id: request.requestID, capabilities: ["exec"] }
      },
      async inspect() {
        return { state: "unknown" }
      },
      async deallocate() {
        deallocations++
        entered.resolve()
        await finish.promise
      },
    })
    await runtime.run(async () => {
      const environment = await bind()
      await (await acquire(environment.id)).release()
      const pending = Environment.deallocate(environment.id, { scopeID: "scope" })
      void pending.catch(() => {})
      try {
        await entered.promise
        const rejected = await Environment.deallocate(environment.id, { scopeID: "scope" }).catch(
          (error: unknown) => error,
        )
        expect(rejected).toBeInstanceOf(Environment.Busy)
        finish.resolve()
        expect((await pending).state).toBe("idle")
        expect(deallocations).toBe(1)
      } finally {
        finish.resolve()
        await pending.catch(() => {})
      }
    })
  }, 30_000)

  for (const operation of ["allocate", "deallocate"] as const) {
    test(`${backend}: failed ${operation} releases ownership for reconciliation`, async () => {
      const failure = new Error("provider response lost")
      let fail = true
      let allocation: { id: string; capabilities: string[] } | undefined
      await using runtime = await open({
        id: "held-provider",
        async allocate(request) {
          allocation = { id: request.requestID, capabilities: ["exec"] }
          if (operation === "allocate" && fail) {
            fail = false
            throw failure
          }
          return allocation
        },
        async inspect() {
          return allocation ? { state: "ready", allocation } : { state: "absent" }
        },
        async deallocate() {
          allocation = undefined
          if (operation === "deallocate" && fail) {
            fail = false
            throw failure
          }
        },
      })
      await runtime.run(async () => {
        const environment = await bind()
        if (operation === "deallocate") await (await acquire(environment.id)).release()
        const request =
          operation === "allocate"
            ? acquire(environment.id)
            : Environment.deallocate(environment.id, { scopeID: "scope" })
        const rejected = await request.catch((error: unknown) => error)
        expect(rejected).toBe(failure)
        expect((await Environment.get(environment.id, "scope")).state).toBe(
          operation === "allocate" ? "allocating" : "releasing",
        )
        expect((await Environment.reconcile(environment.id, "scope")).state).toBe(
          operation === "allocate" ? "ready" : "idle",
        )
        await (await acquire(environment.id)).release()
        expect((await Environment.deallocate(environment.id, { scopeID: "scope" })).state).toBe("idle")
      })
    }, 30_000)
  }

  test(`${backend}: provider ownership is isolated across Runtimes with the same Environment identity`, async () => {
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const provider: EnvironmentProvider = {
      id: "held-provider",
      async allocate(request) {
        return { id: request.requestID, capabilities: ["exec"] }
      },
      async inspect() {
        return { state: "absent" }
      },
      async deallocate() {},
    }
    await using first = await open({
      ...provider,
      async allocate(request) {
        entered.resolve()
        await finish.promise
        return provider.allocate(request)
      },
    })
    await using second = await open(provider)
    const environment = await first.run(bind)
    await second.run(() =>
      Storage.transaction(async () => {
        await Storage.write(StoragePath.environment(environment.id), environment)
        await Storage.write(StoragePath.environmentScope(environment.scopeID, environment.id), environment.id)
      }),
    )
    const pending = first.run(() => acquire(environment.id))
    void pending.catch(() => {})
    try {
      await entered.promise
      await second.run(async () => {
        const use = await acquire(environment.id)
        expect(use.target.environmentID).toBe(environment.id)
        expect((await Environment.get(environment.id, "scope")).state).toBe("ready")
        await use.release()
        expect((await Environment.deallocate(environment.id, { scopeID: "scope" })).state).toBe("idle")
      })
      await second.close()
      finish.resolve()
      const use = await pending
      await first.run(async () => {
        expect((await Environment.get(environment.id, "scope")).state).toBe("ready")
        await use.release()
        expect((await Environment.deallocate(environment.id, { scopeID: "scope" })).state).toBe("idle")
      })
    } finally {
      finish.resolve()
      await pending.catch(() => {})
    }
  }, 30_000)
}
