import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { HomeRestoration } from "@ericsanchezok/synergy-harness/lifecycle/home-restoration"
import { SnapshotMaintenance } from "@ericsanchezok/synergy-harness/session/snapshot-maintenance"
import { AuthorityJournal } from "@ericsanchezok/synergy-harness/storage/authority-journal"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceContent, WorkspaceBlobs } from "@ericsanchezok/synergy-harness/workspace/content"
import { FileAtomicWrite } from "@ericsanchezok/synergy-local-runtime/file/atomic-write"
import { OrganizationCloudProtocol as Cloud } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationBackupCohort as Cohort } from "../../src/backup/cohort"
import { OrganizationRecoveryArchive as Archive } from "../../src/backup/archive"
import { OrganizationServiceNative as Native } from "../../src/backup/service-native"
import { OrganizationRecoveryAuthority as Authority } from "../../src/backup/authority"
import { OrganizationCurrentAuthority as Current } from "../../src/backup/current-authority"
import { OrganizationRecovery as Recovery } from "../../src/backup/recovery"
import { OrganizationBackupAdministration as Administration } from "../../src/backup/administration"
import { OrganizationSourcePreparation as Preparation } from "../../src/backup/source-preparation"
import {
  openOrganizationRecovery,
  openOrganizationService,
  openOrganizationSourceRetirement,
  openOrganizationSourcePreparation,
  openOrganizationPendingRetirement,
} from "../../src/service"
import { resourceFixture } from "../support/resource-native"

const keys = {
  async current() {
    return { version: "resource-recovery", key: Buffer.alloc(32, 13) }
  },
  async resolve() {
    return Buffer.alloc(32, 13)
  },
}
const actor = {
  kind: "system" as const,
  subjectID: "operator",
  displayName: "Operator",
  clientKind: "system" as const,
  requestID: "resources",
}

test("resource recovery preserves both object heads in independent ports through cold retry and current-policy publication without compute", async () => {
  await using f = await resourceFixture()
  const encrypted = path.join(f.root, "encrypted")
  const report = await Cohort.capture({
    service: Cohort.service(f.source.service.maintenance),
    resolve: async () => undefined,
    directory: encrypted,
    archiveID: "resource-recovery",
    buildVersion: "fixture",
    keys,
    actor,
  })
  const h0 = await f.source.service.maintenance.run(() => AuthorityJournal.head())
  expect(
    (
      await f.owner.request("POST", "/auth/password", {
        currentPassword: "correct horse battery staple",
        password: "current resource recovery password",
      })
    ).status,
  ).toBe(200)
  const opened = path.join(f.root, "opened")
  await Archive.open({ directory: encrypted, outputDirectory: opened, keys })
  const base = path.join(opened, "namespaces", "0000000000000000")
  const inventory = Cohort.NamespaceInventory.parse(await Bun.file(path.join(base, "namespace.json")).json())
  if (!inventory.native || !inventory.resources) throw new Error("Missing original native resource facets")
  const restoreID = crypto.randomUUID()
  const request = Native.installationRequest({
    restoreID,
    source: inventory.namespace,
    expected: inventory.native,
    resources: inventory.resources,
    snapshot: inventory.segment.namespace,
    cohort: {
      archiveID: report.archiveID,
      pagesHash: report.pagesHash,
      ordinal: inventory.ordinal,
      source: { orgID: inventory.identity.orgID, deploymentIncarnation: inventory.identity.deploymentIncarnation },
    },
  })
  const resources = {
    directory: path.join(base, "resources"),
    expected: inventory.resources,
    namespaceDirectory: path.join(base, "records"),
  }
  const nativeInput = {
    directory: path.join(base, "native"),
    expected: inventory.native,
    source: inventory.namespace,
    resources,
    keys,
    request,
  }
  const home = path.join(f.root, "target")
  const missingPorts = path.join(f.root, "missing-target-ports"),
    wrongPorts = path.join(f.root, "wrong-target-profiles")
  await expect(Administration.install({ home: missingPorts, directory: encrypted, restoreID, keys })).rejects.toThrow(
    "explicit target resource composition",
  )
  expect(await fs.exists(missingPorts)).toBe(false)
  await expect(
    Administration.install({
      home: wrongPorts,
      directory: encrypted,
      restoreID,
      keys,
      targetInfrastructure: { cloud: { ...f.targetCloud, workspaceProfiles: { different: { blobStore: "files" } } } },
    }),
  ).rejects.toThrow("exact declared target profiles")
  expect(await fs.exists(wrongPorts)).toBe(false)
  let installationID: string | undefined
  async function withTarget<T>(
    restore: boolean,
    body: (value: {
      permit: HomeRestoration.InstallPermit
      native: Native.Installed
      installationID: string
    }) => Promise<T>,
  ) {
    await using target = await openOrganizationRecovery({ home, cloud: f.targetCloud })
    return await target.run(async () => {
      const installation = await HomeRestoration.begin(request)
      return HomeRestoration.withTarget(installation, (permit) => {
        const selected = HomeRestoration.describe(permit).installationID
        if (installationID) expect(selected).toBe(installationID)
        else installationID = selected
        return Native.withInstalled({ ...nativeInput, permit }, (native) =>
          SnapshotMaintenance.withInstalledSegment(
            {
              permit,
              request,
              directory: path.join(base, "snapshots"),
              namespaceDirectory: path.join(base, "records"),
              source: inventory.namespace,
              expected: inventory.segment.namespace,
              keys,
            },
            async (snapshot) => {
              if (restore)
                await StorageCheckpoint.restoreArchive({
                  directory: path.join(base, "records"),
                  expected: inventory.namespace,
                  keys,
                  restoreID: request.restoreID,
                  finalize: (tx, archive) =>
                    Native.adoptRestoration(tx, { permit, request, native, snapshot, archive }).then(() => {}),
                })
              return body({ permit, native, installationID: selected })
            },
          ),
        )
      })
    })
  }
  const lost = new Error("Actual target object write acknowledgement lost")
  f.loseNextPut(lost)
  const mutable = {
    ...f.targetCloud,
    blobStores: { files: { ...f.targetCloud.blobStores!.files! } },
    workspaceProfiles: structuredClone(f.targetCloud.workspaceProfiles!),
  }
  const first = Administration.install({
    home,
    directory: encrypted,
    restoreID,
    keys,
    targetInfrastructure: { cloud: mutable },
  })
  mutable.blobStores.files.put = async () => {
    throw new Error("Replacement target callback must not execute")
  }
  mutable.workspaceProfiles.files!.blobStore = "replacement-target"
  await expect(first).rejects.toBe(lost)
  expect((await fs.readdir(f.received)).length).toBeGreaterThan(0)
  await expect(openOrganizationService({ home, cloud: f.targetCloud })).rejects.toThrow(/restoration|incomplete/i)
  const held = await Administration.install({
    home,
    directory: encrypted,
    restoreID,
    keys,
    targetInfrastructure: { cloud: f.targetCloud },
  })
  expect(held).toMatchObject({ state: "recovery-held", executionEnabled: false })
  installationID = held.installationID
  const work = path.join(f.root, "source-work")
  await fs.mkdir(work, { mode: 0o700 })
  const h1 = path.join(work, "h1")
  const original = await withTarget(true, async (context) => {
    const prepared = await Authority.reopen({
      ...context,
      request,
      namespaceDirectory: path.join(base, "records"),
      keys,
    })
    const info = Authority.describe(prepared)
    await f.source.service.close()
    const reference = await Recovery.withTarget({ ...context, request, prepared }, (target) =>
      Recovery.withPreparationTarget(target, (preparationTarget) =>
        Preparation.withOriginal(
          {
            target: preparationTarget,
            work,
            publicOrigin: "https://resources-recovered.example",
            sourceOrigin: "https://organization.example",
          },
          async (preparation) => {
            const capture = async <T>(
              existingWork: boolean,
              consume: (current: Current.Source, retain: () => void) => Promise<T>,
            ) => {
              await using source = await openOrganizationSourcePreparation({
                home: f.source.service.home,
                cloud: f.sourceCloud,
                publicOrigin: "https://organization.example",
                preparation,
              })
              return await source.run(() =>
                Preparation.withLease(preparation, { existingWork }, (lease, retain) =>
                  Current.withSource({ lease, after: h0, directory: h1, buildVersion: "fixture", keys }, (current) =>
                    consume(current, retain),
                  ),
                ),
              )
            }
            const warm = await capture(false, async (current, retain) => {
              retain()
              return Current.describe(current)
            })
            const files = ["records", "native", "resources"].map((name) => path.join(h1, name, "manifest.json"))
            const originalFiles = await Promise.all(files.map((filename) => fs.readFile(filename)))
            return await capture(true, async (current) => {
              expect(Current.describe(current)).toEqual(warm)
              expect(await Promise.all(files.map((filename) => fs.readFile(filename)))).toEqual(originalFiles)
              const reference = await Current.retirementReference(current, info.reference)
              await FileAtomicWrite.withRoot(work, (root) =>
                FileAtomicWrite.write(
                  root,
                  ["reference.json"],
                  Buffer.from(
                    JSON.stringify({ version: 1, reference, publicOrigin: "https://resources-recovered.example" }) +
                      "\n",
                  ),
                ),
              )
              return reference
            })
          },
        ),
      ),
    )
    const fixedNamespace = {
      directory: path.join(h1, "records"),
      expected: StorageCheckpoint.Manifest.parse(await Bun.file(path.join(h1, "records", "manifest.json")).json()),
    }
    const fixedNative = {
      directory: path.join(h1, "native"),
      expected: StorageCheckpoint.Manifest.parse(await Bun.file(path.join(h1, "native", "manifest.json")).json()),
      resources: {
        directory: path.join(h1, "resources"),
        expected: StorageCheckpoint.Manifest.parse(await Bun.file(path.join(h1, "resources", "manifest.json")).json()),
        namespaceDirectory: fixedNamespace.directory,
      },
    }
    expect((await Bun.file(path.join(work, "reference.json")).json()).reference).toEqual(reference)
    await using pending = await openOrganizationPendingRetirement({
      home: f.source.service.home,
      cloud: f.sourceCloud,
      reference,
    })
    await Current.resumeRetirement({
      source: pending.source,
      target: { ...context, request, prepared },
      namespace: fixedNamespace,
      native: fixedNative,
      keys,
    })
    await pending.close()
    return { info, reference, installationID: context.installationID }
  })
  await f.source.service.close()
  await fs.rm(f.original, { recursive: true })
  const namespace = {
    directory: path.join(h1, "records"),
    expected: StorageCheckpoint.Manifest.parse(await Bun.file(path.join(h1, "records", "manifest.json")).json()),
  }
  const currentResources = {
    directory: path.join(h1, "resources"),
    expected: StorageCheckpoint.Manifest.parse(await Bun.file(path.join(h1, "resources", "manifest.json")).json()),
    namespaceDirectory: namespace.directory,
  }
  const native = {
    directory: path.join(h1, "native"),
    expected: StorageCheckpoint.Manifest.parse(await Bun.file(path.join(h1, "native", "manifest.json")).json()),
    resources: currentResources,
  }
  await using source = await openOrganizationSourceRetirement({
    home: f.source.service.home,
    reference: original.reference,
  })
  const physical = await source.complete()
  await withTarget(false, async (context) => {
    const prepared = await Authority.reopen({
      ...context,
      request,
      namespaceDirectory: path.join(base, "records"),
      keys,
    })
    expect(Authority.describe(prepared)).toEqual(original.info)
    await Recovery.withTarget({ ...context, request, prepared }, (target) =>
      source.run(() =>
        Recovery.publishServiceOnly({
          source: physical,
          target,
          namespace,
          native,
          keys,
          publicOrigin: "https://resources-recovered.example",
        }),
      ),
    )
  })
  await source.close()
  await using completion = await openOrganizationRecovery({ home, cloud: f.targetCloud })
  await completion.run(() => Recovery.completeServicePublication(original.installationID))
  await completion.close()
  await using normal = await openOrganizationService({
    home,
    cloud: f.targetCloud,
    publicOrigin: "https://resources-recovered.example",
  })
  expect((await normal.fetch(new Request("https://resources-recovered.example/org/v1/ready"))).status).toBe(200)
  const login = await normal.fetch(
    new Request("https://resources-recovered.example/org/v1/auth/login", {
      method: "POST",
      headers: { origin: "https://resources-recovered.example", "content-type": "application/json" },
      body: JSON.stringify({ loginName: "owner", password: "current resource recovery password" }),
    }),
  )
  expect(login.status).toBe(200)
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!,
    csrf = ((await login.json()) as { csrfToken: string }).csrfToken
  const read = await normal.fetch(
    new Request(`https://resources-recovered.example/org/v1/cloud/workspaces/${f.workspace.workspaceID}/read`, {
      method: "POST",
      headers: {
        origin: "https://resources-recovered.example",
        "content-type": "application/json",
        cookie,
        "x-csrf-token": csrf,
      },
      body: JSON.stringify({ path: "data.bin", offset: 0, length: Cloud.chunkBytes }),
    }),
  )
  expect(read.status).toBe(200)
  expect(Buffer.from(Cloud.Bytes.parse(await read.json()).data, "base64")).toEqual(f.versions[1]!)
  await normal.maintenance.run(async () => {
    const info = (await WorkspaceCatalog.readMany([f.workspace.workspaceID]))[0]!
    const spec = WorkspaceContent.Spec.parse(info.backend!.spec),
      store = WorkspaceBlobs.get(spec.blobStore, spec.settings)
    for (const [index, expected] of f.versions.entries()) {
      const [version] = await Storage.readMany([["workspace_content", info.id, String(index + 1)]])
      const content = WorkspaceCatalog.Content.parse(version)
      await WorkspaceContent.withTree({ ...info, content }, store, async (tree) => {
        const bytes: Uint8Array[] = []
        for await (const chunk of tree.read("data.bin")) bytes.push(chunk)
        expect(Buffer.concat(bytes)).toEqual(expected)
      })
    }
  })
  expect(f.allocations).toBe(0)
}, 30_000)
