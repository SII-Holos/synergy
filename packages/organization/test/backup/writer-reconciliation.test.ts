import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import { HomeRestoration } from "@ericsanchezok/synergy-harness/lifecycle/home-restoration"
import { HomeOwnership } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import { NativeNamespaceIdentity } from "@ericsanchezok/synergy-harness/lifecycle/namespace-identity"
import { NamespaceRetirement } from "@ericsanchezok/synergy-harness/lifecycle/namespace-retirement"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { SnapshotMaintenance } from "@ericsanchezok/synergy-harness/session/snapshot-maintenance"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import {
  OrganizationRuntimeProtocol as Runtime,
  OrganizationResourceProtocol as Resource,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationRecoveryWriters as Writers } from "../../src/backup/writers"
import { OrganizationInstallationReference } from "../../src/backup/installation-reference"
import { OrganizationServiceHome } from "../../src/service-home"
import { openOrganizationRecovery } from "../../src/service"
import { OrganizationRecord as Record } from "../../src/storage/records"
import { OrganizationStoragePath as Addresses } from "../../src/storage/path"
import { fixture } from "../support/organization"
import { keys as machineKeys, proof, consume } from "../support/runtime"

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const actor = {
  kind: "system" as const,
  subjectID: "operator",
  displayName: "Operator",
  clientKind: "system" as const,
  requestID: "writer-reconciliation",
}
const keys = {
  async current() {
    return { version: "fixture", key: Buffer.alloc(32, 19) }
  },
  async resolve() {
    return Buffer.alloc(32, 19)
  },
}

async function setup(
  options: { revoked?: boolean; inventory?: boolean; finalCommand?: boolean; policies?: boolean } = {},
) {
  const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "writer-reconciliation-"))
  const service = await fixture()
  const owner = await service.initialize()
  const machine = await machineKeys()
  const ticket = Runtime.Ticket.parse(
    await (await owner.request("POST", "/runtimes/hosted", { name: "Writer", publicKey: machine.publicKey })).json(),
  )
  const registration = Runtime.HostedRegistrationRecord.parse(
    await (await consume(service, await proof(ticket, machine.privateKey))).json(),
  )
  if (options.revoked) {
    expect(
      (
        await owner.request("POST", `/runtimes/${registration.runtimeID}/revoke`, {
          expectedRevision: registration.revision,
        })
      ).status,
    ).toBe(200)
  }
  if (options.inventory) {
    for (let index = 0; index < 129; index++)
      expect((await owner.request("POST", "/projects", { name: `Canonical project ${index}` })).status).toBe(200)
    await service.service.maintenance.run(() =>
      Storage.write(["organization-retention", "unclassified"], { version: 1 }),
    )
  }
  if (options.finalCommand)
    await service.service.maintenance.run(() =>
      Storage.write(Addresses.commandState("unclassified-session"), { schemaVersion: 1, commandSeq: 2 }),
    )
  const resources: Array<z.infer<typeof Resource.AdminView>> = []
  const ownerID = await service.service.maintenance.run(
    async () => Record.Info.parse(await Storage.read(Addresses.info())).owners[0],
  )
  if (options.policies) {
    for (const configuration of [
      {
        protocol: "openai-compatible",
        endpoint: "https://model.example/v1",
        model: { id: "fixture", name: "Fixture", limit: { context: 8192, output: 1024 } },
      },
      { protocol: "fixed-http", endpoint: "https://connection.example/v1", method: "POST" },
    ]) {
      const response = await owner.request("POST", "/resources", {
        name: "Policy resource",
        scope: { kind: "organization" },
        configuration,
        credential: { kind: "bearer", value: "task-owned-policy-credential" },
      })
      expect(response.status).toBe(200)
      const resource = Resource.AdminView.parse(await response.json())
      expect(
        (
          await owner.request("PUT", `/resources/${resource.resourceID}/grants/account/${ownerID}`, {
            expectedRevision: 0,
            enabled: true,
          })
        ).status,
      ).toBe(200)
      resources.push(resource)
    }
  }
  const home = await runtimeHome()
  const selected = {
    schemaVersion: 2 as const,
    owner: "organization-runtime",
    identity: hash(registration),
    readerContract: "kernel-native-source-fixture-v1",
  }
  await HomeOwnershipFile.open({ root: home.host.root, env: home.host.env, selected }).persist()
  const filename = path.join(home.host.root, "fixture-enrollment.json")
  await fs.writeFile(filename, JSON.stringify(registration), { mode: 0o600 })
  const facets = new WeakMap<object, { archive: SnapshotMaintenance.ArchiveEvidence; hash: string }>()
  const source = await testRuntime({
    home: home.host.home,
    register() {
      HomeOwnership.select(selected)
      RuntimeMaintenance.configure({ required: ["sessions", "loop-jobs", "environments"] })
      NativeNamespaceIdentity.register({
        owner: selected.owner,
        async read() {
          const current = Runtime.HostedRegistrationRecord.parse(await Bun.file(filename).json())
          return {
            kind: "hosted",
            orgID: current.orgID,
            deploymentIncarnation: current.deploymentIncarnation,
            runtimeID: current.runtimeID,
            publicKey: current.publicKey,
          }
        },
      })
      NamespaceRetirement.registerSource({
        owner: selected.owner,
        inspect(native, archive) {
          const captured = facets.get(native)
          if (!captured || captured.archive !== archive)
            throw new Error("Fixture native source requires its captured archive")
          SnapshotMaintenance.assertArchive(archive)
          return captured.hash
        },
      })
    },
  })
  let serviceLease: RuntimeMaintenance.Lease | undefined
  const namespace = await service.service.maintenance.run(async () => {
    serviceLease = await RuntimeMaintenance.begin({ purpose: "organization-backup", requestID: actor.requestID, actor })
    await RuntimeMaintenance.freeze(serviceLease, await RuntimeMaintenance.drain(serviceLease))
    return RuntimeMaintenance.withFrozen(serviceLease, () =>
      SnapshotMaintenance.withCapture(
        async (capture) =>
          (
            await capture.exportArchive({
              directory: path.join(directory, "service"),
              archiveID: "service-h1",
              namespaceID: registration.orgID,
              buildVersion: "fixture",
              keys,
              protect: () => true,
            })
          ).namespace,
      ),
    )
  })
  const target = await openOrganizationRecovery({ home: path.join(directory, "target") })
  return {
    directory,
    registration,
    namespace,
    source,
    service,
    target,
    resources,
    ownerID,
    async run<T>(body: (input: Parameters<typeof Writers.withReconciled>[0]) => Promise<T>) {
      return target.run(async () => {
        const request = HomeRestoration.Request.parse({
          owner: "organization",
          restoreID: "writer-target",
          sourceHash: hash(namespace),
          payload: { nativeHash: hash(namespace) },
        })
        const handle = await HomeRestoration.begin(request)
        return HomeRestoration.withTarget(handle, async (permit) => {
          await HomeRestoration.installOwner(permit, {
            identity: hash("service-writer-fixture"),
            readerContract: OrganizationServiceHome.readerContract,
          })
          await StorageCheckpoint.restoreArchive({
            directory: path.join(directory, "service"),
            expected: namespace,
            keys,
            restoreID: request.restoreID,
            finalize: async (tx, archive) => {
              await RuntimeMaintenance.adoptRestoration(tx, { permit, request, archive })
            },
          })
          const info = HomeRestoration.describe(permit)
          const reference = OrganizationInstallationReference.parse({
            installationID: info.installationID,
            incarnation: info.incarnation,
            restoreID: info.restoreID,
            requestHash: info.requestHash,
            sourceHash: info.sourceHash,
            nativeHash: hash(namespace),
          })
          return source.run(async () => {
            const lease = await RuntimeMaintenance.begin({
              purpose: "organization-backup",
              requestID: actor.requestID,
              actor,
            })
            await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
            return RuntimeMaintenance.withFrozen(lease, () =>
              SnapshotMaintenance.withCapture(async (capture) => {
                const archive = await capture.exportArchive({
                  directory: path.join(directory, "hosted"),
                  archiveID: "hosted-h1",
                  namespaceID: registration.runtimeID,
                  buildVersion: "fixture",
                  keys,
                  protect: () => true,
                })
                const evidence = await capture.validateArchive(archive)
                const native = Object.freeze({ kind: "fixture-native-facet" })
                facets.set(native, {
                  archive: evidence,
                  hash: hash({ archive, registration: await Bun.file(filename).json() }),
                })
                return NamespaceRetirement.withSource(
                  {
                    archive: evidence,
                    lease,
                    native,
                    target: { request, installationID: reference.installationID, incarnation: reference.incarnation },
                  },
                  async (captured) => {
                    const receipt = await NamespaceRetirement.retire(captured)
                    return NamespaceRetirement.withVerified(receipt, (inspection) =>
                      target.run(() =>
                        body({
                          permit,
                          request,
                          target: reference,
                          namespace: { directory: path.join(directory, "service"), expected: namespace },
                          keys,
                          sources: [inspection],
                        }),
                      ),
                    )
                  },
                )
              }),
            )
          })
        })
      })
    },
    async [Symbol.asyncDispose]() {
      await target.close()
      if (serviceLease) await service.service.maintenance.run(() => RuntimeMaintenance.release(serviceLease!))
      await source.close()
      await home[Symbol.asyncDispose]()
      await service[Symbol.asyncDispose]()
      await fs.rm(directory, { recursive: true, force: true })
    },
  }
}

test("service writer reconciliation consumes actual Kernel NativeSource retirement and rejects copied proof or missing roster evidence", async () => {
  await using f = await setup()
  let expired: (() => void) | undefined
  await f.run(async (input) => {
    await expect(Writers.withReconciled({ ...input, sources: [] }, async () => {})).rejects.toThrow("reconciliation")
    await expect(
      Writers.withReconciled(
        { ...input, sources: [{ kind: "native-namespace-retirement-inspection" }] },
        async () => {},
      ),
    ).rejects.toThrow("physical inspection")
    await Writers.withReconciled(input, async (evidence) => {
      expect(Writers.inspect(evidence)).toMatchObject({ hosted: 1, namespaceHash: hash(f.namespace) })
      expired = () => Writers.inspect(evidence)
      const registrations = [...Writers.hosted(evidence)]
      expect(registrations[0].registration.runtimeID).toBe(f.registration.runtimeID)
      expect(registrations[0].registration.publicKey).toBe(f.registration.publicKey)
      expect(await HomeOwnershipFile.open({ root: f.source.host.root, env: f.source.host.env }).read()).toMatchObject({
        schemaVersion: 4,
      })
    })
    expect(expired).toThrow("callback")
  })
}, 30_000)

test("fresh Hosted registration publication preserves revocation and original identity and seals caught later writes", async () => {
  await using f = await setup({ revoked: true })
  await f.run(async (input) => {
    const original = Record.RuntimeRegistration.parse(await Storage.read(Addresses.runtime(f.registration.runtimeID)))
    await expect(
      Writers.withReconciled({ ...input, sources: [...input.sources, ...input.sources] }, async () => {}),
    ).rejects.toThrow("duplicate")
    await expect(
      Writers.withReconciled(
        { ...input, target: { ...input.target, installationID: crypto.randomUUID() } },
        async () => {},
      ),
    ).rejects.toThrow("foreign original installation")
    await Writers.withReconciled(input, async (evidence) => {
      const reason = new Error("Abort after real Hosted publication")
      await expect(
        RuntimeMaintenance.restorationTransaction({ permit: input.permit, request: input.request }, async (tx) => {
          await Writers.publish(evidence, tx)
          expect(await Storage.read(Addresses.runtime(f.registration.runtimeID))).toMatchObject({
            runtimeID: f.registration.runtimeID,
            publicKey: f.registration.publicKey,
            state: "revoked",
            deploymentIncarnation: input.target.incarnation,
          })
          throw reason
        }),
      ).rejects.toBe(reason)
      expect(await Storage.read(Addresses.runtime(f.registration.runtimeID))).toEqual(original)
      await expect(
        RuntimeMaintenance.restorationTransaction({ permit: input.permit, request: input.request }, async (tx) => {
          await Writers.publish(evidence, tx)
          await expect(Storage.write(["unknown-late-owner"], { hidden: true })).rejects.toThrow("writes after")
        }),
      ).rejects.toThrow("reconciliation")
      expect(await Storage.read(Addresses.runtime(f.registration.runtimeID))).toEqual(original)
      await RuntimeMaintenance.restorationTransaction({ permit: input.permit, request: input.request }, (tx) =>
        Writers.publish(evidence, tx),
      )
      expect(await Storage.read(Addresses.runtime(f.registration.runtimeID))).toEqual({
        ...original,
        deploymentIncarnation: input.target.incarnation,
        revision: f.registration.revision + 2,
      })
    })
  })
}, 30_000)

test("the full authenticated H1 inventory retains unknown retention owners beyond ordinary page sizes", async () => {
  await using f = await setup({ inventory: true })
  await f.run(async (input) => {
    await expect(Writers.withReconciled(input, async () => {})).rejects.toThrow("organization-retention")
  })
}, 30_000)

test("a target with H0 command facts cannot use its H1 Hosted registration to hide pending work", async () => {
  await using f = await setup()
  await f.run(async (input) => {
    await RuntimeMaintenance.restorationTransaction({ permit: input.permit, request: input.request }, () =>
      Storage.write(Addresses.commandState("stale-session"), {
        schemaVersion: 1,
        commandSeq: 2,
        pendingAttemptID: "not-reconciled",
      }),
    )
    await expect(Writers.withReconciled(input, async () => {})).rejects.toThrow("pending command")
  })
}, 30_000)

test("a final command counter does not certify its execution owner's physical settlement", async () => {
  await using f = await setup({ finalCommand: true })
  await f.run(async (input) => {
    await expect(Writers.withReconciled(input, async () => {})).rejects.toThrow("missing H1 owner record")
    expect(await Storage.read(Addresses.commandState("unclassified-session"))).toEqual({
      schemaVersion: 1,
      commandSeq: 2,
    })
  })
}, 30_000)

test("Model and Connection policies retain exact H1 private records and derived access coverage", async () => {
  await using f = await setup({ policies: true })
  await f.run(async (input) => {
    await Writers.withReconciled(input, async () => {})
    await RuntimeMaintenance.restorationTransaction({ permit: input.permit, request: input.request }, () =>
      Storage.remove([...Addresses.accountResources(f.registration.orgID, f.ownerID), f.resources[0].resourceID]),
    )
    await expect(Writers.withReconciled(input, async () => {})).rejects.toThrow("incomplete H1")
  })
}, 30_000)
