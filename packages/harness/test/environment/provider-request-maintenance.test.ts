import { expect, test } from "bun:test"
import { Environment } from "../../src/environment"
import { EnvironmentMaintenance } from "../../src/environment/maintenance"
import { EnvironmentProviders, type EnvironmentProvider } from "../../src/environment/provider"
import { storageTestBackends } from "../support/storage-backends"
import { testRuntime } from "../support/runtime"

for (const backend of storageTestBackends()) {
  for (const operation of ["allocate", "deallocate"] as const) {
    test(`${backend}: maintenance preserves an owned ${operation} request until it settles`, async () => {
      const entered = Promise.withResolvers<void>()
      const finish = Promise.withResolvers<void>()
      let allocation: { id: string; capabilities: string[] } | undefined
      let inspected = 0
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
          allocation = undefined
          entered.resolve()
          await finish.promise
        },
        async inspect() {
          inspected++
          return allocation ? { state: "ready", allocation } : { state: "absent" }
        },
      }
      await using runtime = await testRuntime({
        postgres: backend === "postgres" ? process.env.SYNERGY_TEST_POSTGRES_URL : undefined,
        register: () => EnvironmentProviders.register(provider),
      })
      await runtime.run(async () => {
        const environment = await Environment.bind({
          scopeID: "scope",
          ownerID: "session",
          provider: provider.id,
          spec: {},
        })
        const acquire = () =>
          Environment.acquire(environment.id, { scopeID: "scope", useID: "tool", capabilities: ["exec"] })
        const release = async () => {
          await (await acquire()).release()
          return Environment.deallocate(environment.id, { scopeID: "scope" })
        }
        const pending = operation === "allocate" ? acquire() : release()
        void pending.catch(() => {})
        try {
          await entered.promise
          await EnvironmentMaintenance.tick()
          finish.resolve()
          const result = await pending
          if ("release" in result) await result.release()
          expect(inspected).toBe(0)
          expect((await Environment.get(environment.id, "scope")).state).toBe(
            operation === "allocate" ? "ready" : "idle",
          )
        } finally {
          finish.resolve()
          await pending.catch(() => {})
        }
      })
    }, 30000)
  }
}
