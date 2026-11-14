import { expect, test } from "bun:test"
import { Environment } from "../../src/environment"
import { EnvironmentProviders } from "../../src/environment/provider"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { testEnvironmentRuntime as testRuntime } from "../support/environment-origin"

test("a provider's accepted release callback belongs to its original Runtime and storage lifetime", async () => {
  await using foreign = await testRuntime()
  const storage = await foreign.run(() => Storage.current())
  let deallocations = 0
  let escaped: (() => Promise<unknown>) | undefined
  await using source = await testRuntime({
    register() {
      EnvironmentProviders.register({
        id: "owned-release",
        async allocate(request) {
          return { id: request.requestID, capabilities: [] }
        },
        async inspect(request) {
          return { state: "ready", allocation: { id: request.requestID, capabilities: [] } }
        },
        async deallocate() {
          deallocations++
        },
        async withDeallocation(info, release) {
          escaped = release
          await foreign.run(() => Storage.write(StoragePath.environment(info.id), info))
          await expect(foreign.run(release)).rejects.toThrow("release owner")
          await expect(Storage.provide(storage, release)).rejects.toThrow("release owner")
          await expect(
            Storage.provide({ ...Storage.current(), artifactDirectory: storage.artifactDirectory }, release),
          ).rejects.toThrow("release owner")
          expect(await foreign.run(() => Environment.get(info.id, info.scopeID))).toEqual(info)
          expect(deallocations).toBe(0)
          return release()
        },
      })
    },
  })
  await source.run(async () => {
    const info = await Environment.bind({ scopeID: "scope", ownerID: "owner", provider: "owned-release", spec: {} })
    await (
      await Environment.acquire(info.id, {
        scopeID: "scope",
        useID: "fixture",
        ownership: source.origin("fixture"),
        capabilities: [],
      })
    ).release()
    const result = await Environment.deallocate(info.id, { scopeID: "scope" })
    expect(result.state).toBe("idle")
    expect(deallocations).toBe(1)
    if (!escaped) throw new Error("Expected the original release callback")
    await expect(escaped()).rejects.toThrow("release owner")
    expect(deallocations).toBe(1)
  })
})

test.each(["returns", "throws"] as const)(
  "an early provider wrapper %s cannot abandon its already started release",
  async (mode) => {
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const failure = new Error("Provider wrapper failed after admitting release")
    let native: Promise<unknown> | undefined
    let deallocations = 0
    await using runtime = await testRuntime({
      register() {
        Environment.registerResourceOwner("final-save", async () => {
          entered.resolve()
          await finish.promise
        })
        EnvironmentProviders.register({
          id: "early-release",
          async allocate(request) {
            return { id: request.requestID, capabilities: [] }
          },
          async inspect(request) {
            return { state: "ready", allocation: { id: request.requestID, capabilities: [] } }
          },
          async deallocate() {
            deallocations++
          },
          async withDeallocation(info, release) {
            native = Promise.all([release(), release()])
            void native.catch(() => {})
            await entered.promise
            if (mode === "throws") throw failure
            return info
          },
        })
      },
    })
    await runtime.run(async () => {
      const info = await Environment.bind({ scopeID: "scope", ownerID: "owner", provider: "early-release", spec: {} })
      await (
        await Environment.acquire(info.id, {
          scopeID: "scope",
          useID: "fixture",
          ownership: runtime.origin("fixture"),
          capabilities: [],
        })
      ).release()
      let settled = false
      const releasing = Environment.deallocate(info.id, { scopeID: "scope" })
      void releasing.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        },
      )
      await entered.promise
      try {
        await Bun.sleep(20)
        expect(settled).toBe(false)
      } finally {
        finish.resolve()
        await native?.catch(() => {})
        await releasing.catch(() => {})
      }
      if (mode === "throws") await expect(releasing).rejects.toBe(failure)
      else expect((await releasing).state).toBe("idle")
      expect(deallocations).toBe(1)
      expect((await Environment.get(info.id, "scope")).state).toBe("idle")
    })
  },
  15000,
)

test("distinct wrapper and native release failures retain both causes and the original allocation", async () => {
  const entered = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const wrapperFailure = new Error("Wrapper lost its original owner")
  const saveFailure = new Error("Final native save failed")
  let deallocations = 0
  await using runtime = await testRuntime({
    register() {
      Environment.registerResourceOwner("failed-save", async () => {
        entered.resolve()
        await finish.promise
        throw saveFailure
      })
      EnvironmentProviders.register({
        id: "failed-release",
        async allocate(request) {
          return { id: request.requestID, capabilities: [] }
        },
        async inspect(request) {
          return { state: "ready", allocation: { id: request.requestID, capabilities: [] } }
        },
        async deallocate() {
          deallocations++
        },
        async withDeallocation(_info, release) {
          void release().catch(() => {})
          await entered.promise
          throw wrapperFailure
        },
      })
    },
  })
  await runtime.run(async () => {
    const info = await Environment.bind({ scopeID: "scope", ownerID: "owner", provider: "failed-release", spec: {} })
    await (
      await Environment.acquire(info.id, {
        scopeID: "scope",
        useID: "fixture",
        ownership: runtime.origin("fixture"),
        capabilities: [],
      })
    ).release()
    const original = await Environment.get(info.id, "scope")
    const releasing = Environment.deallocate(info.id, { scopeID: "scope" })
    void releasing.catch(() => {})
    await entered.promise
    finish.resolve()
    await expect(releasing).rejects.toBeInstanceOf(AggregateError)
    await expect(releasing).rejects.toMatchObject({ errors: [wrapperFailure, saveFailure] })
    expect(deallocations).toBe(0)
    expect(await Environment.get(info.id, "scope")).toMatchObject({
      state: "releasing",
      allocation: original.allocation,
      generation: original.generation,
    })
  })
}, 15000)
