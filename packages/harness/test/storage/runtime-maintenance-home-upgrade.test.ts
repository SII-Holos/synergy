import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { createHash } from "node:crypto"
import { RuntimeContext } from "../../src/lifecycle/context"
import { HomeOwnership } from "../../src/lifecycle/home-ownership"
import { HomeOwnershipFile } from "../../src/lifecycle/home-ownership-file"
import { NativeNamespaceIdentity } from "../../src/lifecycle/namespace-identity"
import { RuntimeMaintenance } from "../../src/storage/runtime-maintenance"
import { Storage } from "../../src/storage/storage"
import {
  TransactionalStore,
  type StoreTransaction,
  type TransactionOptions,
} from "../../src/storage/transactional-store"
import { StorageCommitUnknownError } from "../../src/storage/errors"
import { ServerProcessLock } from "../../src/util/server-process-lock"
import { runtimeHome } from "../support/runtime-home"
import { storageTestRuntime } from "../support/storage-runtime"
import { registerEnvironmentMaintenanceOwner } from "../../src/environment/maintenance-owner"
import { EnvironmentSchema } from "../../src/environment/schema"
import { EnvironmentExecutionSchema } from "../../src/environment/execution-schema"
import { WorkspaceCatalog } from "../../src/workspace/catalog"
import { WorkspaceOperations } from "../../src/workspace/operations"
import { WorkspaceMounts } from "../../src/workspace/mount"
import { StoragePath } from "../../src/storage/path"

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const source = HomeOwnershipFile.FencedInfo.parse({
  schemaVersion: 2,
  owner: "home-upgrade-fixture",
  identity: hash("the original native Home"),
  readerContract: "home-upgrade-fixture-v1",
})
const target = HomeOwnershipFile.FencedInfo.parse({ ...source, readerContract: "home-upgrade-fixture-v2" })
const nativeKey = ["home-upgrade-fixture", "identity"]
const actor = {
  kind: "system" as const,
  subjectID: "native-operator",
  displayName: "Native operator",
  clientKind: "system" as const,
  requestID: "advance-native-reader",
}

async function native(home: string, version = 1, nativeOwners = false) {
  const f = await runtimeHome({ home })
  const runtime = await storageTestRuntime({ home })
  const context = await runtime.run(() => RuntimeContext.current())
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: "home-upgrade-fixture",
    filename: path.join(f.host.root, "authority.sqlite"),
  })
  context.storage = { store, artifactDirectory: path.join(f.host.root, "artifacts") }
  let writer: Awaited<ReturnType<typeof ServerProcessLock.acquire>> | undefined
  let captured = 0
  let reconciled = 0
  let released = 0
  let opened = 0
  const control: { releaseFailure?: Error } = {}
  async function close() {
    await context.run(async () => {
      await store.close()
      await writer?.release()
    })
    await runtime.close()
  }
  try {
    await context.run(async () => {
      writer = await ServerProcessLock.acquire()
      const files = HomeOwnershipFile.open({ root: f.host.root, env: f.host.env })
      const current = await files.read()
      if (!current) {
        await HomeOwnershipFile.open({ root: f.host.root, env: f.host.env, selected: source }).persist()
        await Storage.write(nativeKey, {
          orgID: "native-organization",
          deploymentIncarnation: "native-deployment",
          signingHash: hash("original signing"),
          busy: false,
        })
      }
      HomeOwnership.select(current ?? source)
      const identity = async () => {
        const value = await Storage.read<{
          orgID: string
          deploymentIncarnation: string
          signingHash: string
          busy: boolean
        }>(nativeKey)
        return value
      }
      const inspect = async () => {
        const value = await identity()
        return value.busy
          ? [
              {
                owner: "native-writer",
                code: "native_writer_busy",
                label: "Drain the original native writer",
                recoverable: true,
              },
            ]
          : []
      }
      NativeNamespaceIdentity.register({
        owner: source.owner,
        async read() {
          const value = await identity()
          return { orgID: value.orgID, deploymentIncarnation: value.deploymentIncarnation }
        },
      })
      RuntimeMaintenance.configure({ required: ["native-writer"] })
      RuntimeMaintenance.register("native-writer", {
        version,
        async suspend(current) {
          await RuntimeMaintenance.assertDraining(current.lease)
        },
        async drain(current) {
          await RuntimeMaintenance.assertDraining(current.lease)
          if ((await inspect()).length) throw new Error("The native writer has not drained")
        },
        inspect,
        async reconcileFrozen(current) {
          if ((await RuntimeMaintenance.assertHeld(current.lease)).phase !== "frozen")
            throw new Error("Cold native inspection requires the original frozen operation")
          if ((await inspect()).length) throw new Error("The native writer is still active")
          reconciled++
        },
        async reconcileReleasing(current) {
          await RuntimeMaintenance.assertReleasing(current.lease)
          if ((await inspect()).length) throw new Error("The original releasing writer is still active")
          reconciled++
        },
        async release(current) {
          await RuntimeMaintenance.assertReleasing(current.lease)
          if ((await inspect()).length) throw new Error("The original native writer cannot reopen")
          if (control.releaseFailure) throw control.releaseFailure
          released++
        },
        async released(current) {
          await RuntimeMaintenance.assertReleased(current.lease)
          opened++
        },
      })
      if (nativeOwners) {
        registerEnvironmentMaintenanceOwner()
        WorkspaceOperations.register()
        WorkspaceMounts.register()
      }
      RuntimeMaintenance.registerHomeUpgradeOwner("native-writer", {
        version: 1,
        async capture() {
          captured++
          const proof = await NativeNamespaceIdentity.capture()
          const value = await identity()
          const selected = HomeOwnershipFile.FencedInfo.parse(await files.read())
          await NativeNamespaceIdentity.verify(proof)
          return {
            version: 1,
            source: selected,
            target,
            namespace: NativeNamespaceIdentity.inspect(proof),
            signingHash: value.signingHash,
          }
        },
        async verify(selection) {
          const value = await identity()
          const actual = await files.read()
          if (
            (JSON.stringify(actual) !== JSON.stringify(selection.source) &&
              JSON.stringify(actual) !== JSON.stringify(selection.target)) ||
            value.busy ||
            selection.signingHash !== value.signingHash ||
            JSON.stringify(selection.namespace) !==
              JSON.stringify({
                owner: source.owner,
                identity: { deploymentIncarnation: value.deploymentIncarnation, orgID: value.orgID },
              })
          )
            throw new Error("The actual original native Home no longer matches its upgrade")
        },
      })
      RuntimeContext.sealComposition()
    })
    return {
      run: context.run,
      runtimeID: context.id,
      store,
      control,
      captured: () => captured,
      reconciled: () => reconciled,
      released: () => released,
      opened: () => opened,
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}

test("the original native Home recovers its frozen reader upgrade without replacing the source Runtime or lease identity", async () => {
  await using home = await runtimeHome()
  const original = await native(home.host.home)
  let frozen: RuntimeMaintenance.Info
  try {
    frozen = await original.run(async () => {
      const lease = await RuntimeMaintenance.begin({
        purpose: "organization-home-upgrade",
        requestID: actor.requestID,
        actor,
      })
      await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
      const retained = await RuntimeMaintenance.assertHeld(lease)
      expect(retained).toMatchObject({
        version: 2,
        purpose: "organization-home-upgrade",
        sourceRuntimeID: original.runtimeID,
        phase: "frozen",
        native: { ownerID: "native-writer", ownerVersion: 1, source, target },
      })
      await RuntimeMaintenance.withFrozen(lease, () =>
        HomeOwnershipFile.open({ root: home.host.root, env: home.host.env, selected: target }).advanceReader(source),
      )
      expect(
        (await RuntimeMaintenance.begin({ purpose: "organization-home-upgrade", requestID: actor.requestID, actor }))
          .maintenanceID,
      ).toBe(lease.maintenanceID)
      expect(original.captured()).toBe(1)
      return retained
    })
  } finally {
    await original.close()
  }
  const reopened = await native(home.host.home)
  try {
    expect(reopened.runtimeID).not.toBe(original.runtimeID)
    await reopened.run(async () => {
      let retainedLease: RuntimeMaintenance.Lease | undefined
      await RuntimeMaintenance.withHomeUpgradeRecovery({ requestID: actor.requestID }, async (lease) => {
        retainedLease = lease
        expect(await RuntimeMaintenance.assertHeld(lease)).toEqual(frozen)
        await expect(RuntimeMaintenance.assertHeld({ ...lease })).rejects.toThrow()
        await RuntimeMaintenance.withFrozen(lease, async () => {
          expect(
            await HomeOwnershipFile.open({ root: home.host.root, env: home.host.env, selected: target }).assert({
              required: true,
            }),
          ).toEqual(target)
        })
        const released = await RuntimeMaintenance.release(lease)
        expect(released).toMatchObject({
          maintenanceID: frozen.maintenanceID,
          requestID: frozen.requestID,
          requestHash: frozen.requestHash,
          sourceRuntimeID: original.runtimeID,
          cohortHash: frozen.cohortHash,
          phase: "released",
          actor,
        })
      })
      expect(retainedLease).toBeDefined()
      await expect(RuntimeMaintenance.assertHeld(retainedLease!)).rejects.toThrow()
      expect(reopened.captured()).toBe(0)
      expect(reopened.reconciled()).toBe(1)
      expect(reopened.released()).toBe(1)
      const settled = await RuntimeMaintenance.status()
      expect(settled?.sourceRuntimeID).toBe(original.runtimeID)
      expect(await Storage.queryKeys({ prefix: ["runtime_maintenance", "operations"], limit: 10 })).toEqual([
        ["runtime_maintenance", "operations", frozen.maintenanceID],
      ])
      expect(await RuntimeMaintenance.retirement(frozen.maintenanceID)).toBeUndefined()
      await RuntimeMaintenance.assertAdmission()
      await Storage.write(["home-upgrade-fixture", "after-release"], { reopened: true })
    })
  } finally {
    await reopened.close()
  }
})

test("cold Home upgrade rejects changed cohorts and alternate primary artifacts without adopting another operation", async () => {
  await using home = await runtimeHome()
  const original = await native(home.host.home)
  let frozen: RuntimeMaintenance.Info
  try {
    frozen = await original.run(async () => {
      const lease = await RuntimeMaintenance.begin({
        purpose: "organization-home-upgrade",
        requestID: actor.requestID,
        actor,
      })
      await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
      return RuntimeMaintenance.assertHeld(lease)
    })
  } finally {
    await original.close()
  }
  const changed = await native(home.host.home, 2)
  let invoked = false
  try {
    await changed.run(async () => {
      await expect(
        RuntimeMaintenance.withHomeUpgradeRecovery({ requestID: actor.requestID }, async () => {
          invoked = true
        }),
      ).rejects.toThrow("cohort")
      expect(await RuntimeMaintenance.status()).toEqual(frozen)
    })
  } finally {
    await changed.close()
  }
  const reopened = await native(home.host.home)
  try {
    await reopened.run(async () => {
      await expect(
        RuntimeMaintenance.withHomeUpgradeRecovery({ requestID: "another-request" }, async () => {
          invoked = true
        }),
      ).rejects.toThrow("original")
      const primary = Storage.current()
      await Storage.provide(
        { ...primary, artifactDirectory: path.join(primary.artifactDirectory, "another") },
        async () => {
          await expect(
            RuntimeMaintenance.withHomeUpgradeRecovery({ requestID: actor.requestID }, async () => {
              invoked = true
            }),
          ).rejects.toThrow("primary")
        },
      )
      expect(invoked).toBe(false)
      expect(await RuntimeMaintenance.status()).toEqual(frozen)
      expect(await RuntimeMaintenance.retirement(frozen.maintenanceID)).toBeUndefined()
    })
  } finally {
    await reopened.close()
  }
})

test("cold Home upgrade accepts only its actual committed release transition after a lost acknowledgement", async () => {
  await using home = await runtimeHome()
  const original = await native(home.host.home)
  let frozen: RuntimeMaintenance.Info
  try {
    frozen = await original.run(async () => {
      const lease = await RuntimeMaintenance.begin({
        purpose: "organization-home-upgrade",
        requestID: actor.requestID,
        actor,
      })
      await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
      return RuntimeMaintenance.assertHeld(lease)
    })
  } finally {
    await original.close()
  }
  const reopened = await native(home.host.home)
  try {
    await reopened.run(async () => {
      const transaction = reopened.store.transaction.bind(reopened.store)
      const unknown = new StorageCommitUnknownError(
        "home-upgrade-release",
        new Error("Original release acknowledgement lost"),
      )
      let lost = 0
      using fault = spyOn(reopened.store, "transaction").mockImplementation(
        async <T>(body: (tx: StoreTransaction) => Promise<T>, options?: TransactionOptions) => {
          const result = await transaction(body, options)
          const info = RuntimeMaintenance.Info.safeParse(result)
          if (!lost && info.success && info.data.version === 2 && info.data.phase === "releasing") {
            lost++
            throw unknown
          }
          return result
        },
      )
      await RuntimeMaintenance.withHomeUpgradeRecovery({ requestID: actor.requestID }, async (lease) => {
        const released = await RuntimeMaintenance.release(lease)
        expect(released).toMatchObject({
          maintenanceID: frozen.maintenanceID,
          sourceRuntimeID: original.runtimeID,
          phase: "released",
          revision: frozen.revision + 2,
        })
      })
      expect(lost).toBe(1)
      expect(reopened.released()).toBe(1)
      await RuntimeMaintenance.assertAdmission()
    })
  } finally {
    await reopened.close()
  }
})

test("cold Home upgrade cannot adopt a legacy backup hold or its actual permanent retirement reservation", async () => {
  await using home = await runtimeHome()
  const original = await native(home.host.home)
  let frozen: RuntimeMaintenance.Info
  try {
    frozen = await original.run(async () => {
      const lease = await RuntimeMaintenance.begin({
        purpose: "organization-backup",
        requestID: actor.requestID,
        actor,
      })
      await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
      await RuntimeMaintenance.withFrozen(lease, () =>
        RuntimeMaintenance.reserveRetirement(lease, hash("original permanent source")),
      )
      return RuntimeMaintenance.assertHeld(lease)
    })
  } finally {
    await original.close()
  }
  const reopened = await native(home.host.home)
  try {
    await reopened.run(async () => {
      let invoked = false
      await expect(
        RuntimeMaintenance.withHomeUpgradeRecovery({ requestID: actor.requestID }, async () => {
          invoked = true
        }),
      ).rejects.toThrow("witness")
      expect(invoked).toBe(false)
      expect(await RuntimeMaintenance.status()).toEqual(frozen)
      expect((await RuntimeMaintenance.retirement(frozen.maintenanceID))?.source).toEqual(frozen)
      await expect(RuntimeMaintenance.assertAdmission()).rejects.toThrow()
    })
  } finally {
    await reopened.close()
  }
})

test("a cold draining Home upgrade obtains a real current drainage receipt before freezing its original operation", async () => {
  await using home = await runtimeHome()
  const original = await native(home.host.home)
  let draining: RuntimeMaintenance.Info
  try {
    draining = await original.run(async () => {
      const lease = await RuntimeMaintenance.begin({
        purpose: "organization-home-upgrade",
        requestID: actor.requestID,
        actor,
      })
      return RuntimeMaintenance.assertHeld(lease)
    })
  } finally {
    await original.close()
  }
  const reopened = await native(home.host.home)
  try {
    await reopened.run(async () => {
      await RuntimeMaintenance.withHomeUpgradeRecovery({ requestID: actor.requestID }, async (lease) => {
        expect(await RuntimeMaintenance.assertDraining(lease)).toEqual(draining)
        const receipt = await RuntimeMaintenance.drain(lease)
        await expect(RuntimeMaintenance.freeze(lease, { ...receipt })).rejects.toThrow("actual owner drainage")
        await RuntimeMaintenance.freeze(lease, receipt)
        expect((await RuntimeMaintenance.assertHeld(lease)).phase).toBe("frozen")
        await RuntimeMaintenance.withFrozen(lease, () =>
          HomeOwnershipFile.open({ root: home.host.root, env: home.host.env, selected: target }).advanceReader(source),
        )
        const settled = await RuntimeMaintenance.release(lease)
        expect(settled).toMatchObject({
          maintenanceID: draining.maintenanceID,
          sourceRuntimeID: original.runtimeID,
          phase: "released",
          revision: draining.revision + 3,
        })
      })
      expect(reopened.reconciled()).toBe(0)
      expect(reopened.released()).toBe(1)
      await RuntimeMaintenance.assertAdmission()
    })
  } finally {
    await reopened.close()
  }
})

test("a cold releasing Home upgrade resumes its actual releasing owner without refreezing or readmitting work", async () => {
  await using home = await runtimeHome()
  const original = await native(home.host.home)
  let releasing: RuntimeMaintenance.Info
  try {
    releasing = await original.run(async () => {
      const lease = await RuntimeMaintenance.begin({
        purpose: "organization-home-upgrade",
        requestID: actor.requestID,
        actor,
      })
      await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
      await RuntimeMaintenance.withFrozen(lease, () =>
        HomeOwnershipFile.open({ root: home.host.root, env: home.host.env, selected: target }).advanceReader(source),
      )
      const reason = new Error("The original native release ended before completion")
      original.control.releaseFailure = reason
      await expect(RuntimeMaintenance.release(lease)).rejects.toBe(reason)
      return RuntimeMaintenance.assertReleasing(lease)
    })
  } finally {
    await original.close()
  }
  const reopened = await native(home.host.home)
  try {
    await reopened.run(async () => {
      await RuntimeMaintenance.withHomeUpgradeRecovery({ requestID: actor.requestID }, async (lease) => {
        expect(await RuntimeMaintenance.assertReleasing(lease)).toEqual(releasing)
        await expect(RuntimeMaintenance.withFrozen(lease, async () => {})).rejects.toThrow("frozen")
        const settled = await RuntimeMaintenance.release(lease)
        expect(settled).toMatchObject({
          maintenanceID: releasing.maintenanceID,
          sourceRuntimeID: original.runtimeID,
          phase: "released",
          revision: releasing.revision + 1,
        })
      })
      expect(reopened.reconciled()).toBe(1)
      expect(reopened.released()).toBe(1)
      await RuntimeMaintenance.assertAdmission()
    })
  } finally {
    await reopened.close()
  }
})

for (const field of ["sourceRuntimeID", "maintenanceID"] as const)
  test(`a corrupted canonical ${field} cannot rebind an existing native Home upgrade receipt`, async () => {
    await using home = await runtimeHome()
    const original = await native(home.host.home)
    let frozen: RuntimeMaintenance.Info
    try {
      frozen = await original.run(async () => {
        const lease = await RuntimeMaintenance.begin({
          purpose: "organization-home-upgrade",
          requestID: actor.requestID,
          actor,
        })
        await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
        return RuntimeMaintenance.assertHeld(lease)
      })
    } finally {
      await original.close()
    }
    const reopened = await native(home.host.home)
    try {
      await reopened.run(async () => {
        const originalKey = ["runtime_maintenance", "operations", frozen.maintenanceID]
        const requestKey = ["runtime_maintenance", "requests", actor.requestID]
        const substitutedID = crypto.randomUUID()
        await reopened.store.transaction(async (tx) => {
          const retained = await tx.read<RuntimeMaintenance.Info>(originalKey)
          if (field === "sourceRuntimeID") {
            await tx.write(originalKey, { ...retained, sourceRuntimeID: reopened.runtimeID })
            return
          }
          await tx.write(["runtime_maintenance", "operations", substitutedID], {
            ...retained,
            maintenanceID: substitutedID,
          })
          const request = await tx.read<{ maintenanceID: string; requestHash: string }>(requestKey)
          await tx.write(requestKey, { ...request, maintenanceID: substitutedID })
          await tx.write(["runtime_maintenance", "current"], { maintenanceID: substitutedID })
          const drained = await tx.read(["runtime_maintenance", "owners", frozen.maintenanceID, "native-writer"])
          await tx.write(["runtime_maintenance", "owners", substitutedID, "native-writer"], drained)
        })
        const corrupted = await RuntimeMaintenance.status()
        let invoked = false
        await expect(
          RuntimeMaintenance.withHomeUpgradeRecovery({ requestID: actor.requestID }, async () => {
            invoked = true
          }),
        ).rejects.toThrow("original request")
        expect(invoked).toBe(false)
        expect(reopened.released()).toBe(0)
        expect(await RuntimeMaintenance.status()).toEqual(corrupted)
        expect((await reopened.store.read<{ requestHash: string }>(requestKey)).requestHash).toBe(frozen.requestHash)
        await expect(RuntimeMaintenance.assertAdmission()).rejects.toThrow()
      })
    } finally {
      await reopened.close()
    }
  })

test("Home upgrade native owners recover an actually idle frozen cohort through their real inspections", async () => {
  await using home = await runtimeHome()
  const original = await native(home.host.home, 1, true)
  let frozen: RuntimeMaintenance.Info
  try {
    frozen = await original.run(async () => {
      const lease = await RuntimeMaintenance.begin({
        purpose: "organization-home-upgrade",
        requestID: actor.requestID,
        actor,
      })
      await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
      return RuntimeMaintenance.assertHeld(lease)
    })
  } finally {
    await original.close()
  }
  const reopened = await native(home.host.home, 1, true)
  try {
    await reopened.run(async () => {
      await RuntimeMaintenance.withHomeUpgradeRecovery({ requestID: actor.requestID }, async (lease) => {
        expect(await RuntimeMaintenance.assertHeld(lease)).toEqual(frozen)
        expect((await RuntimeMaintenance.release(lease)).phase).toBe("released")
      })
      await RuntimeMaintenance.assertAdmission()
    })
  } finally {
    await reopened.close()
  }
})

const retainedTarget = { environmentID: "retained-environment", allocationID: "retained-allocation", generation: 1 }
const coldOccupancy: Array<{
  name: string
  owner: string
  code: string
  seed(tx: StoreTransaction): Promise<void>
}> = [
  {
    name: "foreign Environment metadata address",
    owner: "environments",
    code: "environment_inventory_unknown",
    async seed(tx) {
      await tx.write(
        StoragePath.environment("another-environment"),
        EnvironmentSchema.Info.parse({
          id: retainedTarget.environmentID,
          scopeID: "retained-scope",
          provider: "retained-provider",
          spec: {},
          ownership: "managed",
          state: "idle",
          generation: 0,
          idleTimeoutMs: 0,
          createdAt: 1,
          updatedAt: 1,
          lastUsedAt: 1,
        }),
      )
    },
  },
  {
    name: "foreign Workspace operation metadata address",
    owner: "workspace-operations",
    code: "workspace_operation_inventory_unknown",
    async seed(tx) {
      const info = WorkspaceOperations.Info.parse({
        id: "retained-write",
        scopeID: "retained-scope",
        workspaceID: "retained-workspace",
        generation: 1,
        input: {
          kind: "objects-write",
          id: "retained-write",
          path: "unknown.txt",
          data: "YQ==",
          expectedVersion: null,
        },
        digest: hash("original retained write"),
        state: "completed",
        createdAt: 1,
        updatedAt: 1,
      })
      await tx.write(StoragePath.workspaceOperation(info.scopeID, "another-write"), info)
    },
  },
  {
    name: "foreign Workspace catalog metadata address",
    owner: "workspace-mounts",
    code: "workspace_mount_inventory_unknown",
    async seed(tx) {
      const info = WorkspaceCatalog.Info.parse({
        id: "retained-workspace",
        scopeID: "retained-scope",
        type: "objects",
        revision: 1,
        binding: { state: "bound", hostID: "retained-host", path: null, generation: 1 },
        metadata: {},
        sharedWritableWorkspaceIDs: [],
        lifecycle: "active",
        createdAt: 1,
        updatedAt: 1,
      })
      await tx.write(StoragePath.workspace("another-workspace"), info)
    },
  },
  {
    name: "ready allocation without its active index",
    owner: "environments",
    code: "environment_allocation_retained",
    async seed(tx) {
      await tx.write(
        StoragePath.environment(retainedTarget.environmentID),
        EnvironmentSchema.Info.parse({
          id: retainedTarget.environmentID,
          scopeID: "retained-scope",
          provider: "retained-provider",
          spec: {},
          ownership: "managed",
          state: "ready",
          generation: 1,
          allocation: { requestID: "retained-request", id: retainedTarget.allocationID, capabilities: ["exec"] },
          idleTimeoutMs: 0,
          createdAt: 1,
          updatedAt: 1,
          lastUsedAt: 1,
        }),
      )
    },
  },
  {
    name: "unknown native Use without a reconstructable owner",
    owner: "environments",
    code: "environment_use_unknown",
    async seed(tx) {
      await tx.write(StoragePath.environmentUse(retainedTarget.environmentID, "retained-use"), {
        id: "retained-use",
        target: retainedTarget,
        createdAt: 1,
        kind: "operation",
      })
    },
  },
  ...(["unknown", "completed"] as const).map((state) => ({
    name: `${state} execution without its active index or original owner`,
    owner: "environments",
    code: "environment_execution_unknown",
    async seed(tx: StoreTransaction) {
      const execution = EnvironmentExecutionSchema.Info.parse({
        id: "retained-execution",
        scopeID: "retained-scope",
        target: retainedTarget,
        digest: hash("original retained command"),
        state,
        outputCursor: 0,
        createdAt: 1,
        updatedAt: 1,
        origin: { kind: "legacy-unknown" },
      })
      await tx.write(StoragePath.environmentExecution(execution.scopeID, execution.id), { schemaVersion: 2, execution })
    },
  })),
  {
    name: "unknown Workspace operation without its active index",
    owner: "workspace-operations",
    code: "workspace_save_unsettled",
    async seed(tx) {
      const info = WorkspaceOperations.Info.parse({
        id: "retained-write",
        scopeID: "retained-scope",
        workspaceID: "retained-workspace",
        generation: 1,
        input: {
          kind: "objects-write",
          id: "retained-write",
          path: "unknown.txt",
          data: "YQ==",
          expectedVersion: null,
        },
        digest: hash("original retained write"),
        state: "unknown",
        createdAt: 1,
        updatedAt: 1,
      })
      await tx.write(StoragePath.workspaceOperation(info.scopeID, info.id), info)
    },
  },
  ...[false, true].map((indexed) => ({
    name: `active native Workspace mount ${indexed ? "with" : "without"} its derived index`,
    owner: "workspace-mounts",
    code: "workspace_mount_retained",
    async seed(tx: StoreTransaction) {
      const workspace = WorkspaceCatalog.Info.parse({
        id: "retained-workspace",
        scopeID: "retained-scope",
        type: "objects",
        revision: 1,
        binding: { state: "bound", hostID: "retained-host", path: null, generation: 1 },
        metadata: {},
        sharedWritableWorkspaceIDs: [],
        lifecycle: "active",
        createdAt: 1,
        updatedAt: 1,
        activeMount: {
          id: "retained-mount",
          generation: 1,
          target: retainedTarget,
          path: "/retained-workspace",
          state: "active",
        },
      })
      await tx.write(StoragePath.workspace(workspace.id), workspace)
      if (indexed)
        await tx.write(StoragePath.workspaceEnvironment(retainedTarget.environmentID, workspace.id), workspace.scopeID)
    },
  })),
]

for (const occupancy of coldOccupancy)
  test(`Home upgrade native owner refuses canonical ${occupancy.name}`, async () => {
    await using home = await runtimeHome()
    const original = await native(home.host.home, 1, true)
    let frozen: RuntimeMaintenance.Info
    try {
      frozen = await original.run(async () => {
        const lease = await RuntimeMaintenance.begin({
          purpose: "organization-home-upgrade",
          requestID: actor.requestID,
          actor,
        })
        await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
        return RuntimeMaintenance.assertHeld(lease)
      })
    } finally {
      await original.close()
    }
    const reopened = await native(home.host.home, 1, true)
    try {
      await reopened.run(async () => {
        await reopened.store.transaction(occupancy.seed)
        let invoked = false
        await expect(
          RuntimeMaintenance.withHomeUpgradeRecovery({ requestID: actor.requestID }, async () => {
            invoked = true
          }),
        ).rejects.toMatchObject({
          data: {
            requirements: expect.arrayContaining([
              expect.objectContaining({ owner: occupancy.owner, code: occupancy.code }),
            ]),
          },
        })
        expect(invoked).toBe(false)
        expect(await RuntimeMaintenance.status()).toEqual(frozen)
        expect(reopened.released()).toBe(0)
      })
    } finally {
      await reopened.close()
    }
  })

async function completedNativeHome(home: string) {
  const original = await native(home, 1, true)
  try {
    return await original.run(async () => {
      const lease = await RuntimeMaintenance.begin({
        purpose: "organization-home-upgrade",
        requestID: actor.requestID,
        actor,
      })
      await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
      const host = RuntimeContext.current().host
      await RuntimeMaintenance.withFrozen(lease, () =>
        HomeOwnershipFile.open({ root: host.root, env: host.env, selected: target }).advanceReader(source),
      )
      return RuntimeMaintenance.release(lease)
    })
  } finally {
    await original.close()
  }
}

test("a released Home upgrade inspects an idle original native cohort before reopening its recorded completion", async () => {
  await using home = await runtimeHome()
  const completed = await completedNativeHome(home.host.home)
  const reopened = await native(home.host.home, 1, true)
  try {
    await reopened.run(async () => {
      await RuntimeMaintenance.withHomeUpgradeRecovery({ requestID: actor.requestID }, async (lease) => {
        expect(await RuntimeMaintenance.assertReleased(lease)).toEqual(completed)
        expect(await RuntimeMaintenance.release(lease)).toEqual(completed)
      })
      expect(reopened.opened()).toBe(1)
      expect(reopened.released()).toBe(0)
      expect(await RuntimeMaintenance.status()).toEqual(completed)
      await RuntimeMaintenance.assertAdmission()
    })
  } finally {
    await reopened.close()
  }
})

test("a released Home upgrade cannot use its historical receipt to reopen a later active mount with a valid index", async () => {
  await using home = await runtimeHome()
  const completed = await completedNativeHome(home.host.home)
  const reopened = await native(home.host.home, 1, true)
  try {
    await reopened.run(async () => {
      const workspace = WorkspaceCatalog.Info.parse({
        id: "later-native-view",
        scopeID: "later-scope",
        type: "objects",
        revision: 1,
        binding: { state: "bound", hostID: "later-host", path: null, generation: 1 },
        metadata: {},
        sharedWritableWorkspaceIDs: [],
        lifecycle: "active",
        createdAt: 2,
        updatedAt: 2,
        activeMount: {
          id: "later-native-mount",
          generation: 1,
          target: retainedTarget,
          path: "/later-native-view",
          state: "active",
        },
      })
      const key = StoragePath.workspace(workspace.id)
      const index = StoragePath.workspaceEnvironment(retainedTarget.environmentID, workspace.id)
      await reopened.store.transaction(async (tx) => {
        await tx.write(key, workspace)
        await tx.write(index, workspace.scopeID)
      })
      expect(await Storage.queryKeys({ prefix: ["environment_use"], limit: 1 })).toEqual([])
      let invoked = false
      const outcome = await RuntimeMaintenance.withHomeUpgradeRecovery(
        { requestID: actor.requestID },
        async (lease) => {
          invoked = true
          await RuntimeMaintenance.release(lease)
        },
      ).then(
        () => ({ rejected: false as const, invoked, opened: reopened.opened() }),
        (error: unknown) => ({ rejected: true as const, error }),
      )
      expect(outcome).toMatchObject({
        rejected: true,
        error: {
          data: {
            requirements: expect.arrayContaining([
              expect.objectContaining({ owner: "workspace-mounts", code: "workspace_mount_retained" }),
            ]),
          },
        },
      })
      expect(invoked).toBe(false)
      expect(reopened.opened()).toBe(0)
      expect(await RuntimeMaintenance.status()).toEqual(completed)
      expect(await Storage.read(key)).toEqual(workspace)
      expect(await Storage.read(index)).toBe(workspace.scopeID)
    })
  } finally {
    await reopened.close()
  }
})

test("a released Home upgrade rechecks later native ownership at its final reopen boundary", async () => {
  await using home = await runtimeHome()
  const completed = await completedNativeHome(home.host.home)
  const reopened = await native(home.host.home, 1, true)
  try {
    await reopened.run(async () => {
      let entered = false
      await RuntimeMaintenance.withHomeUpgradeRecovery({ requestID: actor.requestID }, async (lease) => {
        entered = true
        const workspace = WorkspaceCatalog.Info.parse({
          id: "view-after-inspection",
          scopeID: "later-scope",
          type: "objects",
          revision: 1,
          binding: { state: "bound", hostID: "later-host", path: null, generation: 1 },
          metadata: {},
          sharedWritableWorkspaceIDs: [],
          lifecycle: "active",
          createdAt: 2,
          updatedAt: 2,
          activeMount: {
            id: "view-created-after-inspection",
            generation: 1,
            target: retainedTarget,
            path: "/view-after-inspection",
            state: "active",
          },
        })
        const key = StoragePath.workspace(workspace.id)
        const index = StoragePath.workspaceEnvironment(retainedTarget.environmentID, workspace.id)
        await reopened.store.transaction(async (tx) => {
          await tx.write(key, workspace)
          await tx.write(index, workspace.scopeID)
        })
        const outcome = await RuntimeMaintenance.release(lease).then(
          () => ({ rejected: false as const, opened: reopened.opened() }),
          (error: unknown) => ({ rejected: true as const, error }),
        )
        expect(outcome).toMatchObject({
          rejected: true,
          error: {
            data: {
              requirements: expect.arrayContaining([
                expect.objectContaining({ owner: "workspace-mounts", code: "workspace_mount_retained" }),
              ]),
            },
          },
        })
        expect(reopened.opened()).toBe(0)
        expect(await RuntimeMaintenance.status()).toEqual(completed)
        expect(await Storage.read(key)).toEqual(workspace)
        expect(await Storage.read(index)).toBe(workspace.scopeID)
      })
      expect(entered).toBe(true)
    })
  } finally {
    await reopened.close()
  }
})
