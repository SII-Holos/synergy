import { beforeEach, expect, test } from "bun:test"
import { createSynergyClient, type ProjectDirectories, type WorkspaceInfo } from "@ericsanchezok/synergy-sdk/client"
import {
  loadProjectDirectoryRecovery,
  recoverProjectDirectories,
} from "../../../src/components/dialog/project-directory-recovery"

let client: ReturnType<typeof createSynergyClient>
let directories: ProjectDirectories
let records: WorkspaceInfo[]
let writes: string[]
let failExtra = false
let loseMain = false
let afterMain: (() => void) | undefined

beforeEach(() => {
  writes = []
  failExtra = false
  loseMain = false
  afterMain = undefined
  directories = {
    version: 1,
    scopeID: "project",
    revision: 1,
    mainWorkspaceID: "main",
    additionalWorkspaceIDs: ["extra"],
    folders: ["main", "extra"].map((workspaceID) => ({
      workspaceID,
      generation: 1,
      path: `/fixture/${workspaceID}`,
      available: false,
      git: false,
      unavailable: {
        name: "WorkspaceUnavailable",
        data: { workspaceID, message: "Identity changed", reason: "identity_changed" },
      },
    })),
  }
  records = directories.folders.map((folder) => ({
    id: folder.workspaceID,
    scopeID: "project",
    type: "directory",
    revision: 1,
    binding: { state: "bound", hostID: "host", path: folder.path, physicalID: "old", generation: 1 },
    metadata: {},
    sharedWritableWorkspaceIDs: [folder.workspaceID === "main" ? "extra" : "main"],
    lifecycle: "active",
    createdAt: 1,
    updatedAt: 1,
  }))
  client = createSynergyClient({
    baseUrl: "http://fixture.example",
    fetch: Object.assign(
      async (requestInput: RequestInfo | URL, init?: RequestInit) => {
        const request = requestInput instanceof Request ? requestInput : new Request(requestInput, init)
        request.signal.throwIfAborted()
        const url = new URL(request.url)
        if (url.searchParams.get("scopeID") !== "project" && !url.pathname.includes("/project/project/"))
          return new Response(null, { status: 404 })
        if (request.method === "GET") return Response.json(url.pathname === "/workspace" ? records : directories)
        const id = url.pathname.split("/")[2]!
        const record = records.find((item) => item.id === id)!
        const input = (await request.json()) as { expectedRevision: number; path: string }
        if (record.revision !== input.expectedRevision)
          return Response.json(
            { name: "WorkspaceBindingChanged", data: { workspaceID: id, message: "Changed" } },
            { status: 409 },
          )
        writes.push(id)
        if (id === "extra" && failExtra)
          return Response.json({ name: "WorkspaceBusy", data: { message: "Folder busy" } }, { status: 409 })
        record.revision++
        record.binding.generation++
        record.binding.path = input.path.replace("/alias/", "/fixture/")
        const folder = directories.folders.find((item) => item.workspaceID === id)!
        Object.assign(folder, {
          generation: record.binding.generation,
          path: record.binding.path,
          available: true,
          git: id === "main",
        })
        delete folder.unavailable
        if (id === "main") afterMain?.()
        if (id === "main" && loseMain)
          return Response.json({ name: "UnknownError", data: { message: "Reply lost" } }, { status: 503 })
        return Response.json(record)
      },
      { preconnect() {} },
    ),
  })
})

test("confirmed recovery restores both folders once and reconciles a lost mutation response", async () => {
  const plan = await loadProjectDirectoryRecovery(client, "project", structuredClone(directories))
  loseMain = true
  const restored: string[] = []
  const result = await recoverProjectDirectories(client, plan, { onRecovered: (id) => restored.push(id) })
  expect(result.folders.every((folder) => folder.available)).toBe(true)
  expect(result.folders[0]!.git).toBe(true)
  expect(writes).toEqual(["main", "extra"])
  expect(restored).toEqual(["main", "extra"])
  await recoverProjectDirectories(client, plan)
  expect(writes).toEqual(["main", "extra"])
  expect(records.map((record) => record.binding.generation)).toEqual([2, 2])
})

test("partial failure preserves recovered folders and retry only rebinds the remaining folder", async () => {
  const plan = await loadProjectDirectoryRecovery(client, "project", structuredClone(directories))
  failExtra = true
  await expect(recoverProjectDirectories(client, plan)).rejects.toMatchObject({ name: "WorkspaceBusy" })
  expect(directories.folders.map((folder) => folder.available)).toEqual([true, false])
  failExtra = false
  await recoverProjectDirectories(client, plan)
  expect(writes).toEqual(["main", "extra", "extra"])
  expect(records.map((record) => record.binding.generation)).toEqual([2, 2])
})

test("a changed project or binding rejects the old confirmation before writing", async () => {
  const plan = await loadProjectDirectoryRecovery(client, "project", structuredClone(directories))
  records[0]!.revision++
  await expect(recoverProjectDirectories(client, plan)).rejects.toMatchObject({
    name: "ProjectDirectoryRecoveryChanged",
  })
  expect(writes).toEqual([])
  directories.revision++
  await expect(loadProjectDirectoryRecovery(client, "project", plan.directories)).rejects.toMatchObject({
    name: "ProjectDirectoryRecoveryChanged",
  })
})

test("confirmed path aliases use the canonical rebind receipt without repeating a successful binding", async () => {
  const plan = await loadProjectDirectoryRecovery(client, "project", structuredClone(directories))
  const options = { paths: { main: "/alias/main", extra: "/alias/extra" } }
  const result = await recoverProjectDirectories(client, plan, options)
  expect(result.folders.map((folder) => folder.path)).toEqual(["/fixture/main", "/fixture/extra"])
  await recoverProjectDirectories(client, plan, options)
  expect(writes).toEqual(["main", "extra"])
})

test("a project change after one restored folder prevents the next mutation", async () => {
  const plan = await loadProjectDirectoryRecovery(client, "project", structuredClone(directories))
  afterMain = () => {
    directories.revision++
  }
  await expect(recoverProjectDirectories(client, plan)).rejects.toMatchObject({
    name: "ProjectDirectoryRecoveryChanged",
  })
  expect(writes).toEqual(["main"])
})

test("cancellation after a successful folder prevents subsequent mutations", async () => {
  const controller = new AbortController()
  const plan = await loadProjectDirectoryRecovery(client, "project", structuredClone(directories))
  afterMain = () => controller.abort()
  await expect(recoverProjectDirectories(client, plan, { signal: controller.signal })).rejects.toThrow()
  expect(writes).toEqual(["main"])
  expect(directories.folders[1]!.available).toBe(false)
})
