import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { OrganizationCloudProtocol as Cloud } from "@ericsanchezok/synergy-organization-protocol"
import type { OrganizationCloudOptions } from "../../src/cloud"
import { fixture } from "./organization"

export async function resourceFixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "resource-backup-")))
  const original = path.join(root, "source-objects"),
    received = path.join(root, "target-objects")
  await Promise.all([fs.mkdir(original), fs.mkdir(received)])
  let allocations = 0
  let losePut: Error | undefined
  const cloud = (directory: string): OrganizationCloudOptions => ({
    blobStores: {
      files: {
        async put(hash, bytes) {
          await fs.writeFile(path.join(directory, hash), bytes)
          if (directory === received && losePut) {
            const error = losePut
            losePut = undefined
            throw error
          }
        },
        async get(hash, maximum) {
          const bytes = await fs.readFile(path.join(directory, hash))
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
  })
  let selected: Awaited<ReturnType<typeof fixture>> | undefined
  const sourceCloud = cloud(original)
  try {
    selected = await fixture(undefined, { cloud: sourceCloud })
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
      const grant = await owner.request(
        "PUT",
        `/resources/${resource.resourceID}/grants/project/${project.projectID}`,
        { expectedRevision: 0, enabled: true },
      )
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
    const versions = [
      Buffer.from("original resource version\u0000\u00ff"),
      Buffer.from("latest resource version\u0000\u00ff"),
    ]
    let current = workspace
    let expectedVersion: string | null = null
    for (const [index, bytes] of versions.entries()) {
      const saved = await owner.request("POST", `/cloud/workspaces/${workspace.workspaceID}/write`, {
        operationID: "file-version-" + index,
        expectedRevision: current.revision,
        path: "data.bin",
        expectedVersion,
        data: bytes.toString("base64"),
      })
      expect(saved.status, await saved.clone().text()).toBe(200)
      current = Cloud.Workspace.parse(await saved.json())
      const read = await owner.request("POST", `/cloud/workspaces/${workspace.workspaceID}/read`, {
        path: "data.bin",
        offset: 0,
        length: Cloud.chunkBytes,
      })
      expect(read.status).toBe(200)
      expectedVersion = Cloud.Bytes.parse(await read.json()).version
    }
    const createdEnvironment = await owner.request("POST", "/cloud/environments", {
      projectID: project.projectID,
      resourceID: compute.resourceID,
      requestID: "create-compute",
      name: "Idle compute",
    })
    expect(createdEnvironment.status, await createdEnvironment.clone().text()).toBe(200)
    const environment = Cloud.Environment.parse(await createdEnvironment.json())
    expect(environment).toMatchObject({ state: "idle", activeUses: 0 })
    const source = selected
    return {
      root,
      original,
      received,
      source,
      owner,
      workspace: current,
      environment,
      versions,
      targetCloud: cloud(received),
      sourceCloud,
      get allocations() {
        return allocations
      },
      loseNextPut(error: Error) {
        losePut = error
      },
      async [Symbol.asyncDispose]() {
        await source[Symbol.asyncDispose]()
        await fs.rm(root, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await selected?.[Symbol.asyncDispose]()
    await fs.rm(root, { recursive: true, force: true })
    throw error
  }
}
