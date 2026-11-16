import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { OrganizationBackupCohort as Cohort } from "../../src/backup/cohort"
import { OrganizationRecoveryArchive as Archive } from "../../src/backup/archive"
import { OrganizationResourceNative as Native } from "../../src/backup/resources"
import { fixture } from "../support/organization"
import { OrganizationCloudProtocol as Cloud } from "@ericsanchezok/synergy-organization-protocol"

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

test("the real Service cohort captures its dormant Workspace bytes and idle Environment without allocating compute", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "resource-backup-")))
  const objects = path.join(root, "objects")
  await fs.mkdir(objects)
  let allocations = 0
  await using cleanup = { [Symbol.asyncDispose]: () => fs.rm(root, { recursive: true, force: true }) }
  await using selected = await fixture(undefined, {
    cloud: {
      blobStores: {
        files: {
          async put(hash, bytes) {
            await fs.writeFile(path.join(objects, hash), bytes)
          },
          async get(hash, maximum) {
            const bytes = await fs.readFile(path.join(objects, hash))
            if (bytes.byteLength > maximum) throw new Error("Object exceeds its frame")
            return bytes
          },
        },
      },
      workspaceProfiles: { files: { blobStore: "files" } },
      environmentProviders: [
        {
          id: "idle-provider",
          async allocate() {
            allocations++
            throw new Error("Backup must not allocate compute")
          },
          async inspect() {
            return { state: "unknown" }
          },
          async deallocate() {
            throw new Error("No allocation exists")
          },
        },
      ],
      environmentProfiles: { compute: { provider: "idle-provider", spec: {} } },
    },
  })
  const owner = await selected.initialize()
  const createdProject = await owner.request("POST", "/projects", { name: "Resources" })
  expect(createdProject.status).toBe(200)
  const project = (await createdProject.json()) as { projectID: string }
  const resource = async (name: string, protocol: "workspace-storage" | "environment", profile: string) => {
    const response = await owner.request("POST", "/resources", {
      name,
      scope: { kind: "project", projectID: project.projectID },
      configuration: { protocol, profile },
      credential: { kind: "none" },
    })
    expect(response.status).toBe(200)
    const resource = (await response.json()) as { resourceID: string; revision: number }
    const grant = await owner.request("PUT", `/resources/${resource.resourceID}/grants/project/${project.projectID}`, {
      expectedRevision: 0,
      enabled: true,
    })
    expect(grant.status, await grant.clone().text()).toBe(200)
    return resource
  }
  const files = await resource("Files", "workspace-storage", "files")
  const compute = await resource("Compute", "environment", "compute")
  const createdWorkspace = await owner.request("POST", "/cloud/workspaces", {
    projectID: project.projectID,
    resourceID: files.resourceID,
    requestID: "create-files",
    name: "Shared files",
  })
  expect(createdWorkspace.status, await createdWorkspace.clone().text()).toBe(200)
  const workspace = Cloud.Workspace.parse(await createdWorkspace.json())
  const bytes = Buffer.from("actual resource checkpoint bytes\u0000\u00ff")
  const saved = await owner.request("POST", `/cloud/workspaces/${workspace.workspaceID}/write`, {
    operationID: "initial-file",
    expectedRevision: workspace.revision,
    path: "data.bin",
    expectedVersion: null,
    data: bytes.toString("base64"),
  })
  expect(saved.status, await saved.clone().text()).toBe(200)
  const createdEnvironment = await owner.request("POST", "/cloud/environments", {
    projectID: project.projectID,
    resourceID: compute.resourceID,
    requestID: "create-compute",
    name: "Idle compute",
  })
  expect(createdEnvironment.status, await createdEnvironment.clone().text()).toBe(200)
  expect(Cloud.Environment.parse(await createdEnvironment.json())).toMatchObject({ state: "idle", activeUses: 0 })
  const directory = path.join(root, "cohort")
  const report = await Cohort.capture({
    service: Cohort.service(selected.service.maintenance),
    resolve: async () => undefined,
    directory,
    archiveID: "resource-cohort",
    buildVersion: "fixture",
    keys,
    actor,
  })
  expect(report.namespaceCheckpointsComplete).toBe(true)
  const opened = path.join(root, "opened")
  await Archive.open({ directory, outputDirectory: opened, keys })
  const base = path.join(opened, "namespaces", "0000000000000000")
  const inventory = Cohort.NamespaceInventory.parse(await Bun.file(path.join(base, "namespace.json")).json())
  expect(inventory.resources).toBeDefined()
  const verified = await selected.service.maintenance.run(() =>
    Native.verify({
      directory: path.join(base, "resources"),
      expected: inventory.resources!,
      source: inventory.namespace,
      namespaceDirectory: path.join(base, "records"),
      keys,
    }),
  )
  expect(verified.workspaces).toBe(1)
  expect(verified.environments).toBe(1)
  expect(allocations).toBe(0)
})
