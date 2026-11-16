import { expect, test } from "bun:test"
import path from "node:path"
import { RuntimeHandle } from "../../src/lifecycle/runtime"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { runtimeHome } from "../support/runtime-home"
import { RuntimeContext } from "../../src/lifecycle/context"
import { HomeOwnership } from "../../src/lifecycle/home-ownership"
import { Global } from "../../src/global"
import fs from "node:fs/promises"

test("a Home with a persisted domain owner cannot open as a personal Runtime", async () => {
  await using fixture = await runtimeHome()
  await Bun.write(
    path.join(fixture.host.root, "home-ownership.json"),
    JSON.stringify({
      schemaVersion: 1,
      owner: "fixture-owner",
      identity: "f".repeat(64),
    }),
  )
  let acquired = 0
  let runtime: Awaited<ReturnType<typeof RuntimeHandle.open>> | undefined
  try {
    await expect(
      RuntimeHandle.open({
        host: fixture.host,
        mode: "oneshot",
        composition: { register() {} },
        storage: {
          kind: "owned",
          async open() {
            acquired++
            const store = await TransactionalStore.open({
              backend: "sqlite",
              filename: path.join(fixture.host.root, "test.sqlite"),
              namespace: "test",
            })
            return {
              handle: { store, artifactDirectory: path.join(fixture.host.root, "data") },
              needsValidation: false,
              async activate() {},
            }
          },
        },
      }).then((value) => {
        runtime = value
        return value
      }),
    ).rejects.toThrow("Home owner")
    expect(acquired).toBe(0)
  } finally {
    await runtime?.close()
  }
  const store = await TransactionalStore.open({
    backend: "sqlite",
    filename: path.join(fixture.host.root, "selected.sqlite"),
    namespace: "selected",
  })
  try {
    await using selected = await RuntimeHandle.open({
      host: fixture.host,
      mode: "oneshot",
      composition: {
        register() {
          HomeOwnership.select({ owner: "fixture-owner", identity: "f".repeat(64) })
        },
      },
      storage: { kind: "borrowed", handle: { store, artifactDirectory: path.join(fixture.host.root, "data") } },
    })
    expect(await selected.run(() => HomeOwnership.read())).toMatchObject({ owner: "fixture-owner" })
  } finally {
    await store.close()
  }
})

test("Home ownership survives selection removal and rejects another identity, malformed records and unknown versions", async () => {
  await using fixture = await runtimeHome()
  const context = RuntimeContext.create(fixture.host)
  const owner = { owner: "fixture-owner", identity: "a".repeat(64) }
  try {
    await context.run(async () => {
      HomeOwnership.select(owner)
      await expect(HomeOwnership.assert({ required: true })).rejects.toThrow("has not persisted")
      await expect(Global.initialize()).rejects.toThrow("has not persisted")
      await Promise.all([HomeOwnership.persist(), HomeOwnership.persist()])
      expect(await HomeOwnership.read()).toEqual({ schemaVersion: 1, ...owner })
      await HomeOwnership.assert({ required: true })
      await Global.initialize({ cache: false })
      await expect(Promise.resolve().then(() => HomeOwnership.select(owner))).rejects.toThrow("already selected")
    })
  } finally {
    context.dispose()
  }
  const filename = path.join(fixture.host.root, "home-ownership.json")
  const original = await Bun.file(filename).text()
  await fs.rm(path.join(fixture.host.root, "config"), { recursive: true, force: true })
  for (const selection of [undefined, { ...owner, identity: "b".repeat(64) }, { ...owner, owner: "another-owner" }]) {
    const context = RuntimeContext.create(fixture.host)
    try {
      await context.run(async () => {
        if (selection) HomeOwnership.select(selection)
        await expect(Global.initialize()).rejects.toThrow("Home owner")
        if (selection) await expect(HomeOwnership.persist()).rejects.toThrow("Home owner")
        expect(
          await fs.access(path.join(fixture.host.root, "config")).then(
            () => true,
            () => false,
          ),
        ).toBe(false)
      })
    } finally {
      context.dispose()
    }
    expect(await Bun.file(filename).text()).toBe(original)
  }
  for (const contents of ["malformed", JSON.stringify({ schemaVersion: 2, ...owner }), "x".repeat(4097)]) {
    await Bun.write(filename, contents)
    const context = RuntimeContext.create(fixture.host)
    try {
      await expect(context.run(() => Global.initialize())).rejects.toThrow("invalid or unsupported")
    } finally {
      context.dispose()
    }
  }
  await Bun.write(filename, original)
  const restored = RuntimeContext.create(fixture.host)
  try {
    await restored.run(async () => {
      HomeOwnership.select(owner)
      await HomeOwnership.assert({ required: true })
      RuntimeContext.sealComposition()
      expect(() => HomeOwnership.select(owner)).toThrow("before opening")
    })
  } finally {
    restored.dispose()
  }
})

test("legacy personal Homes keep their data and do not acquire an organization identity", async () => {
  await using fixture = await runtimeHome()
  const context = RuntimeContext.create(fixture.host)
  try {
    await context.run(async () => {
      expect(await HomeOwnership.read()).toBeUndefined()
      await Global.initialize({ cache: false })
      await HomeOwnership.assert({ required: true })
      await expect(HomeOwnership.persist()).rejects.toThrow("Select a Home owner")
      expect(await HomeOwnership.read()).toBeUndefined()
    })
  } finally {
    context.dispose()
  }
})
