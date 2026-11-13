import { expect, test } from "bun:test"
import path from "node:path"
import { createHash } from "node:crypto"
import { RuntimeContext } from "../../src/lifecycle/context"
import { HomeOwnership } from "../../src/lifecycle/home-ownership"
import { HomeOwnershipFile } from "../../src/lifecycle/home-ownership-file"
import { NativeNamespaceIdentity } from "../../src/lifecycle/namespace-identity"
import { RuntimeMaintenance } from "../../src/storage/runtime-maintenance"
import { Storage } from "../../src/storage/storage"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { ServerProcessLock } from "../../src/util/server-process-lock"
import { runtimeHome } from "../support/runtime-home"
import { storageTestRuntime } from "../support/storage-runtime"

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const marker = HomeOwnershipFile.FencedInfo.parse({
  schemaVersion: 2,
  owner: "source-preparation-fixture",
  identity: hash("original Source Home"),
  readerContract: "source-preparation-fixture-v1",
})
const identityKey = ["source-preparation-fixture", "identity"]
const targetKey = ["source-preparation-target", "installation"]
const actor = {
  kind: "system" as const,
  subjectID: "native-operator",
  displayName: "Native operator",
  clientKind: "system" as const,
  requestID: "original-source-preparation",
}

async function primary(home: string, namespace: string) {
  const f = await runtimeHome({ home })
  const runtime = await storageTestRuntime({ home })
  const context = await runtime.run(() => RuntimeContext.current())
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace,
    filename: path.join(f.host.root, "authority.sqlite"),
  })
  context.storage = { store, artifactDirectory: path.join(f.host.root, "artifacts") }
  const lock = await context.run(() => ServerProcessLock.acquire())
  const writer = await context.run(() => ServerProcessLock.currentOwnership())
  let alive = true
  const assert = () => {
    if (!alive || context.storage?.store !== store || !store.readiness.readerReady)
      throw new Error("The original native primary has ended")
    ServerProcessLock.assertLive(writer)
  }
  const close = async () => {
    if (!alive) return
    alive = false
    await context.run(async () => {
      await store.close()
      await lock.release()
    })
    await runtime.close()
  }
  return {
    run: context.run,
    context,
    store,
    files: HomeOwnershipFile.open({ root: f.host.root, env: f.host.env }),
    assert,
    close,
  }
}

async function targetOwner(home: string) {
  const target = await primary(home, "preparation-target")
  await target.run(async () => {
    const [existing] = await Storage.readMany([targetKey])
    if (existing === undefined)
      await Storage.write(targetKey, { installationID: crypto.randomUUID(), requestHash: hash("original H0 request") })
  })
  return {
    ...target,
    inspect: () => target.run(() => Storage.read(targetKey)),
    [Symbol.asyncDispose]: target.close,
  }
}

async function sourceOwner(home: string, target: Awaited<ReturnType<typeof targetOwner>>) {
  const source = await primary(home, "preparation-source")
  let captures = 0
  let reconciled = 0
  try {
    await source.run(async () => {
      if (!(await source.files.read())) {
        await HomeOwnershipFile.open({
          root: source.context.host.root,
          env: source.context.host.env,
          selected: marker,
        }).persist()
        await Storage.write(identityKey, {
          orgID: "original-organization",
          deploymentIncarnation: "original-deployment",
          signingHash: hash("original signing identity"),
        })
      }
      HomeOwnership.select(marker)
      const identity = () =>
        Storage.read<{ orgID: string; deploymentIncarnation: string; signingHash: string }>(identityKey)
      NativeNamespaceIdentity.register({
        owner: marker.owner,
        async read() {
          const value = await identity()
          return { orgID: value.orgID, deploymentIncarnation: value.deploymentIncarnation }
        },
      })
      RuntimeMaintenance.configure({ required: ["native-writer"] })
      RuntimeMaintenance.register("native-writer", {
        version: 1,
        async suspend(context) {
          await RuntimeMaintenance.assertDraining(context.lease)
        },
        async drain(context) {
          await RuntimeMaintenance.assertDraining(context.lease)
        },
        async inspect() {
          source.assert()
          return []
        },
        async reconcileFrozen(context) {
          expect((await RuntimeMaintenance.assertHeld(context.lease)).phase).toBe("frozen")
          source.assert()
          reconciled++
        },
        async release(context) {
          await RuntimeMaintenance.assertReleasing(context.lease)
        },
      })
      const selection = async () => {
        if (Storage.inTransaction())
          throw new Error("A Target owner must not be borrowed inside a Source SQL transaction")
        source.assert()
        target.assert()
        const proof = await NativeNamespaceIdentity.capture()
        const value = await identity()
        const facts = await target.inspect()
        await NativeNamespaceIdentity.verify(proof)
        return {
          version: 1 as const,
          source: HomeOwnershipFile.FencedInfo.parse(await source.files.read()),
          namespace: NativeNamespaceIdentity.inspect(proof),
          signingHash: value.signingHash,
          selectionHash: hash(facts),
        }
      }
      RuntimeMaintenance.registerSourcePreparationOwner("native-writer", {
        version: 1,
        assert() {
          source.assert()
          target.assert()
        },
        async capture() {
          captures++
          return selection()
        },
        async verify(expected: RuntimeMaintenance.SourcePreparationSelection) {
          if (hash(await selection()) !== hash(expected))
            throw new Error("The actual original Target selection changed")
        },
      })
      RuntimeContext.sealComposition()
    })
    return { ...source, captures: () => captures, reconciled: () => reconciled, [Symbol.asyncDispose]: source.close }
  } catch (error) {
    await source.close()
    throw error
  }
}

test("the original Source preparation cold cap preserves its real native operation and cannot retire or release it", async () => {
  await using directory = await runtimeHome()
  const targetHome = path.join(directory.host.home, "target")
  const sourceHome = path.join(directory.host.home, "source")
  await using target = await targetOwner(targetHome)
  const source = await sourceOwner(sourceHome, target)
  let frozen: RuntimeMaintenance.Info
  try {
    frozen = await source.run(async () => {
      const lease = await RuntimeMaintenance.beginSourcePreparation({ requestID: actor.requestID, actor })
      return RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
    })
    expect(frozen).toMatchObject({ version: 3, purpose: "organization-backup", phase: "frozen" })
    expect(source.captures()).toBe(1)
  } finally {
    await source.close()
    await target.close()
  }
  await using reopenedTarget = await targetOwner(targetHome)
  await using cold = await sourceOwner(sourceHome, reopenedTarget)
  let expired: RuntimeMaintenance.Lease | undefined
  await cold.run(() =>
    RuntimeMaintenance.withSourcePreparationRecovery({ requestID: actor.requestID }, async (lease) => {
      expired = lease
      expect(await RuntimeMaintenance.assertHeld(lease)).toEqual(frozen)
      expect(frozen.sourceRuntimeID).not.toBe(cold.context.id)
      await RuntimeMaintenance.withFrozen(lease, async () => {
        expect(await Storage.read(identityKey)).toMatchObject({ orgID: "original-organization" })
        await expect(RuntimeMaintenance.reserveRetirement(lease, hash("copied Reference"))).rejects.toBeInstanceOf(
          RuntimeMaintenance.Blocked,
        )
      })
      await expect(RuntimeMaintenance.release(lease)).rejects.toBeInstanceOf(RuntimeMaintenance.Blocked)
    }),
  )
  expect(cold.captures()).toBe(0)
  expect(cold.reconciled()).toBe(1)
  expect(await cold.run(() => RuntimeMaintenance.status())).toEqual(frozen)
  if (!expired) throw new Error("The original Source preparation did not enter its owning callback")
  await expect(cold.run(() => RuntimeMaintenance.assertHeld(expired!))).rejects.toBeInstanceOf(
    RuntimeMaintenance.Blocked,
  )
})

test("an existing legacy backup hold cannot acquire a new Source preparation witness", async () => {
  await using directory = await runtimeHome()
  await using target = await targetOwner(path.join(directory.host.home, "target"))
  const home = path.join(directory.host.home, "source")
  const source = await sourceOwner(home, target)
  let original: RuntimeMaintenance.Info
  try {
    original = await source.run(async () => {
      const lease = await RuntimeMaintenance.begin({
        purpose: "organization-backup",
        requestID: actor.requestID,
        actor,
      })
      return RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
    })
    expect(original.version).toBe(1)
  } finally {
    await source.close()
  }
  await using cold = await sourceOwner(home, target)
  let admitted = false
  await expect(
    cold.run(() =>
      RuntimeMaintenance.withSourcePreparationRecovery({ requestID: actor.requestID }, async () => {
        admitted = true
      }),
    ),
  ).rejects.toBeInstanceOf(RuntimeMaintenance.Blocked)
  expect(admitted).toBe(false)
  expect(cold.captures()).toBe(0)
  expect(await cold.run(() => RuntimeMaintenance.status())).toEqual(original)
})

test("a live Source preparation capability rejects a rebound canonical actor with a self-consistent request receipt", async () => {
  await using directory = await runtimeHome()
  await using target = await targetOwner(path.join(directory.host.home, "target"))
  await using source = await sourceOwner(path.join(directory.host.home, "source"), target)
  await source.run(async () => {
    const lease = await RuntimeMaintenance.beginSourcePreparation({ requestID: actor.requestID, actor })
    const frozen = await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
    if (frozen.version !== 3) throw new Error("The actual Source preparation did not retain its native witness")
    const changedActor = {
      ...frozen.actor,
      subjectID: "another-native-operator",
      displayName: "Another native operator",
    }
    const rebound = RuntimeMaintenance.Info.parse({
      ...frozen,
      actor: changedActor,
      requestHash: hash({
        purpose: frozen.purpose,
        maintenanceID: frozen.maintenanceID,
        sourceRuntimeID: frozen.sourceRuntimeID,
        requestID: frozen.requestID,
        actor: changedActor,
        cohortHash: frozen.cohortHash,
        native: frozen.native,
      }),
    })
    await source.store.transaction(async (tx) => {
      await tx.write(["runtime_maintenance", "operations", frozen.maintenanceID], rebound)
      await tx.write(["runtime_maintenance", "requests", frozen.requestID], {
        maintenanceID: rebound.maintenanceID,
        requestHash: rebound.requestHash,
      })
    })
    let admitted = false
    let rejected = false
    try {
      await RuntimeMaintenance.withFrozen(lease, async () => {
        admitted = true
      })
    } catch (error) {
      rejected = error instanceof RuntimeMaintenance.Blocked
    }
    expect({ admitted, rejected }).toEqual({ admitted: false, rejected: true })
    expect(await RuntimeMaintenance.status()).toEqual(rebound)
  })
})
