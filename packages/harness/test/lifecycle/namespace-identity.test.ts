import { expect, test } from "bun:test"
import path from "node:path"
import { NativeNamespaceIdentity as Identity } from "../../src/lifecycle/namespace-identity"
import { HomeOwnership } from "../../src/lifecycle/home-ownership"
import { HomeOwnershipFile } from "../../src/lifecycle/home-ownership-file"
import { RuntimeContext } from "../../src/lifecycle/context"
import { Storage } from "../../src/storage/storage"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { testRuntime } from "../support/runtime"
import { runtimeHome } from "../support/runtime-home"

async function fixture() {
  const home = await runtimeHome()
  const owner = {
    schemaVersion: 2 as const,
    owner: "namespace-fixture",
    identity: "a".repeat(64),
    readerContract: "namespace-fixture-v1",
  }
  await HomeOwnershipFile.open({ root: home.host.root, env: home.host.env, selected: owner }).persist()
  const current: Record<string, string> = { runtimeID: "original", orgID: "organization" }
  const control: { beforeRead?: () => Promise<void> } = {}
  const runtime = await testRuntime({
    home: home.host.home,
    register() {
      HomeOwnership.select(owner)
      Identity.register({
        owner: "namespace-fixture",
        async read() {
          await control.beforeRead?.()
          return { ...current }
        },
      })
    },
  })
  return {
    ...runtime,
    current,
    control,
    async [Symbol.asyncDispose]() {
      await runtime.close()
      await home[Symbol.asyncDispose]()
    },
  }
}

test("native identity evidence verifies its original primary namespace and current owning identity", async () => {
  await using runtime = await fixture()
  const evidence = await runtime.run(() => Identity.capture())
  await runtime.run(async () => {
    expect(Identity.inspect(evidence)).toEqual({ owner: "namespace-fixture", identity: runtime.current })
    await Identity.verify(evidence)
    runtime.current.runtimeID = "changed"
    await expect(Identity.verify(evidence)).rejects.toThrow("identity changed")
  })
})

test("foreign Runtime, alternate Store, artifact configuration and copied evidence cannot certify a namespace", async () => {
  await using runtime = await fixture()
  await using foreign = await fixture()
  const evidence = await runtime.run(() => Identity.capture())
  await foreign.run(async () => {
    await expect(Identity.verify(evidence)).rejects.toThrow("original")
  })
  await runtime.run(async () => {
    await expect(Identity.verify({ ...evidence })).rejects.toThrow("native evidence")
    const handle = Storage.current()
    await Storage.provide(
      { ...handle, artifactDirectory: path.join(handle.artifactDirectory, "another") },
      async () => {
        await expect(Identity.capture()).rejects.toThrow("primary")
        await expect(Identity.verify(evidence)).rejects.toThrow("primary")
      },
    )
    const store = await TransactionalStore.open({
      backend: "sqlite",
      filename: path.join(runtime.host.root, "alternate.sqlite"),
      namespace: "alternate",
    })
    try {
      await Storage.provide({ store, artifactDirectory: handle.artifactDirectory }, async () => {
        await expect(Identity.capture()).rejects.toThrow("primary")
        await expect(Identity.verify(evidence)).rejects.toThrow("primary")
      })
    } finally {
      await store.close()
    }
  })
})

test("identity sources register only during composition and evidence closes with the Runtime", async () => {
  await using runtime = await fixture()
  const evidence = await runtime.run(() => Identity.capture())
  await runtime.run(async () => {
    expect(() =>
      Identity.register({
        owner: "late",
        async read() {
          return {}
        },
      }),
    ).toThrow("before opening")
    const noSource = RuntimeContext.create({ ...runtime.host, root: path.join(runtime.host.root, "unselected") })
    try {
      await noSource.run(async () => {
        await expect(Identity.capture()).rejects.toThrow("unavailable")
      })
    } finally {
      noSource.dispose()
    }
  })
  await runtime.close()
  expect(() => runtime.run(() => Identity.inspect(evidence))).toThrow("closed")
})

test("an asynchronous reader cannot certify changed primary artifacts or an unbounded identity descriptor", async () => {
  await using runtime = await fixture()
  const entered = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  runtime.control.beforeRead = async () => {
    entered.resolve()
    await proceed.promise
  }
  const capturing = runtime.run(() => Identity.capture())
  void capturing.catch(() => {})
  await entered.promise
  await runtime.run(async () => {
    const handle = RuntimeContext.current().storage!
    const original = handle.artifactDirectory
    handle.artifactDirectory = path.join(original, "changed")
    proceed.resolve()
    try {
      await expect(capturing).rejects.toThrow("primary")
    } finally {
      handle.artifactDirectory = original
    }
    runtime.control.beforeRead = undefined
    for (let index = 0; index < 33; index++) runtime.current[`key${index}`] = "value"
    await expect(Identity.capture()).rejects.toThrow()
    for (let index = 0; index < 33; index++) delete runtime.current[`key${index}`]
    runtime.current.runtimeID = "x".repeat(4097)
    await expect(Identity.capture()).rejects.toThrow()
  })
})
