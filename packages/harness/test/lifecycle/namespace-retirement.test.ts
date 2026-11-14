import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { NamespaceRetirement as Retirement } from "../../src/lifecycle/namespace-retirement"
import { NativeNamespaceIdentity } from "../../src/lifecycle/namespace-identity"
import { HomeOwnership } from "../../src/lifecycle/home-ownership"
import { HomeOwnershipFile } from "../../src/lifecycle/home-ownership-file"
import { RuntimeMaintenance } from "../../src/storage/runtime-maintenance"
import { SnapshotMaintenance } from "../../src/session/snapshot-maintenance"
import { Storage } from "../../src/storage/storage"
import { testRuntime } from "../support/runtime"
import { runtimeHome } from "../support/runtime-home"

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const keys = {
  async current() {
    return { version: "native", key: Buffer.alloc(32, 29) }
  },
  async resolve() {
    return Buffer.alloc(32, 29)
  },
}
const actor = {
  kind: "system" as const,
  subjectID: "operator",
  displayName: "Operator",
  clientKind: "system" as const,
  requestID: "native-retirement",
}
async function fixture() {
  const home = await runtimeHome()
  const owner = {
    schemaVersion: 2 as const,
    owner: "namespace-fixture",
    identity: "a".repeat(64),
    readerContract: "native-fixture-v1",
  }
  const files = HomeOwnershipFile.open({ root: home.host.root, env: home.host.env, selected: owner })
  await files.persist()
  const filename = path.join(home.host.root, "native-identity.json")
  const identity = { runtimeID: "native-fixture", orgID: "organization" }
  await fs.writeFile(filename, JSON.stringify(identity))
  const captures = new WeakMap<object, { archive: SnapshotMaintenance.ArchiveEvidence; hash: string }>()
  const runtime = await testRuntime({
    home: home.host.home,
    register() {
      HomeOwnership.select(owner)
      NativeNamespaceIdentity.register({
        owner: owner.owner,
        async read() {
          const actual: unknown = await Bun.file(filename).json()
          if (digest(actual) !== digest(identity)) throw new Error("Native identity changed")
          return identity
        },
      })
      Retirement.registerSource({
        owner: owner.owner,
        inspect(native, archive) {
          const captured = captures.get(native)
          if (!captured || captured.archive !== archive)
            throw new Error("Native retirement requires its original captured file")
          SnapshotMaintenance.assertArchive(archive)
          return captured.hash
        },
      })
      RuntimeMaintenance.configure({ required: ["sessions", "loop-jobs", "environments"] })
    },
  })
  let lease: RuntimeMaintenance.Lease | undefined
  let closed = false
  async function close() {
    if (closed) return
    try {
      await runtime.close()
    } finally {
      closed = true
    }
  }
  return {
    ...runtime,
    close,
    capture<T>(body: (source: Retirement.Source) => Promise<T>) {
      return runtime.run(async () => {
        lease = await RuntimeMaintenance.begin({ purpose: "organization-backup", requestID: actor.requestID, actor })
        const current = lease
        await RuntimeMaintenance.freeze(current, await RuntimeMaintenance.drain(current))
        return RuntimeMaintenance.withFrozen(current, () =>
          SnapshotMaintenance.withCapture(async (capture) => {
            const archive = await capture.exportArchive({
              directory: path.join(home.host.home, "archive"),
              archiveID: "native-fixture",
              namespaceID: "native-fixture",
              buildVersion: "test",
              keys,
              protect: () => true,
            })
            const evidence = await capture.validateArchive(archive)
            const native = Object.freeze({ kind: "native-fixture-capture" })
            captures.set(native, {
              archive: evidence,
              hash: createHash("sha256")
                .update(await fs.readFile(filename))
                .digest("hex"),
            })
            return Retirement.withSource(
              {
                archive: evidence,
                native,
                lease: current,
                target: {
                  installationID: crypto.randomUUID(),
                  incarnation: crypto.randomUUID(),
                  request: {
                    owner: "target-fixture",
                    restoreID: "original-target",
                    sourceHash: digest(archive.namespace),
                    payload: {},
                  },
                },
              },
              body,
            )
          }),
        )
      })
    },
    async [Symbol.asyncDispose]() {
      if (lease && !closed)
        await runtime.run(async () => {
          const current = lease
          if (current && !(await RuntimeMaintenance.retirement(current.maintenanceID)))
            await RuntimeMaintenance.release(current)
        })
      await close()
      await home[Symbol.asyncDispose]()
    },
  }
}

test("native namespace retirement issues only original callback-bound physical proof and preserves its permanent intent", async () => {
  await using source = await fixture()
  await using foreign = await testRuntime()
  let escaped: Retirement.Inspection | undefined
  const reference = await source.capture(async (current) => {
    expect(() => Retirement.describeSource({ ...current })).toThrow("actual captured")
    const reference = Retirement.describeSource(current)
    const receipt = await Retirement.retire(current)
    expect(await HomeOwnershipFile.open({ root: source.host.root, env: source.host.env }).read()).toMatchObject({
      schemaVersion: 4,
      maintenanceID: reference.maintenance.maintenanceID,
      referenceHash: digest(reference),
    })
    await Retirement.withVerified(receipt, (inspection) =>
      foreign.run(async () => {
        escaped = inspection
        expect(Retirement.inspect(inspection)).toEqual(reference)
        expect(() => Retirement.inspect({ ...inspection })).toThrow("actual physical")
      }),
    )
    await expect(Retirement.complete({ ...reference, nativeHash: "f".repeat(64) })).rejects.toThrow(
      "immutable retirement",
    )
    expect(Retirement.describe(await Retirement.complete(reference))).toEqual(reference)
    return reference
  })
  if (!escaped) throw new Error("Missing actual physical inspection")
  const ended = escaped
  await foreign.run(async () => expect(() => Retirement.inspect(ended)).toThrow("ended"))
  await source.run(async () => {
    expect(await RuntimeMaintenance.retirement(reference.maintenance.maintenanceID)).toMatchObject({
      referenceHash: digest(reference),
      source: { phase: "frozen" },
    })
    expect((await RuntimeMaintenance.status())?.phase).toBe("frozen")
  })
})

test("Runtime closure drains an accepted permanent native fence before closing its original Store and process lock", async () => {
  await using source = await fixture()
  const entered = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  const originalOpen = fs.open
  const filename = path.join(source.host.root, "home-ownership.json")
  using delayed = spyOn(fs, "open").mockImplementation(async (...args) => {
    const file = await originalOpen(...args)
    if (String(args[0]) === filename && typeof args[1] === "number" && (args[1] & 2) === 2) {
      const sync = file.sync.bind(file)
      spyOn(file, "sync").mockImplementation(async () => {
        await sync()
        entered.resolve()
        await proceed.promise
      })
    }
    return file
  })
  const effect = source.capture((current) => Retirement.retire(current))
  void effect.catch(() => {})
  await entered.promise
  let closed = false
  const closing = source.close().then(() => {
    closed = true
  })
  await Promise.resolve()
  expect(closed).toBe(false)
  proceed.resolve()
  await effect
  await closing
  expect(closed).toBe(true)
  expect(await HomeOwnershipFile.open({ root: source.host.root, env: source.host.env }).read()).toMatchObject({
    schemaVersion: 4,
  })
})
