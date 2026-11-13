import { expect, test } from "bun:test"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceBlobs } from "@ericsanchezok/synergy-harness/workspace/content"
import { EnvironmentProviders } from "@ericsanchezok/synergy-harness/environment/provider"
import { OrganizationResources as Resources } from "../src/resources"
import { OrganizationCloud as Cloud } from "../src/cloud"
import { directoryFixture } from "./support/session-directory"

async function fixture() {
  const f = await directoryFixture()
  const blobs = new Map<string, Uint8Array>()
  await f.run(() => {
    WorkspaceBlobs.register("cloud-fixture", {
      async put(hash, bytes) {
        blobs.set(hash, bytes.slice())
      },
      async get(hash, maximumBytes) {
        const bytes = blobs.get(hash)
        if (!bytes || bytes.length > maximumBytes) throw new Error("Object unavailable")
        return bytes.slice()
      },
    })
    EnvironmentProviders.register({
      id: "cloud-compute",
      async allocate() {
        throw new Error("Creation must not allocate compute")
      },
      async inspect() {
        return { state: "unknown" }
      },
      async deallocate() {
        throw new Error("No compute allocation")
      },
    })
    Cloud.register({
      workspaceProfiles: { standard: { blobStore: "cloud-fixture" } },
      environmentProfiles: { standard: { provider: "cloud-compute", spec: { image: "fixture" } } },
    })
  })
  return f
}

test("organization cloud files retain one canonical Workspace head and idempotent CAS receipts", async () => {
  await using f = await fixture()
  await f.run(async () => {
    const resource = await Resources.create(f.credentials.admin, {
      name: "Team files",
      scope: { kind: "project", projectID: "project" },
      configuration: { protocol: "workspace-storage", profile: "standard" },
      credential: { kind: "none" },
    })
    await Resources.grant(
      f.credentials.admin,
      resource.resourceID,
      { kind: "project", id: "project" },
      { expectedRevision: 0, enabled: true },
    )
    const input = {
      projectID: "project",
      resourceID: resource.resourceID,
      requestID: "workspace-create",
      name: "Shared",
    }
    const workspace = await Cloud.createWorkspace(f.credentials.alice, input)
    expect(await Cloud.createWorkspace(f.credentials.alice, input)).toEqual(workspace)
    const change = {
      operationID: "write-once",
      expectedRevision: 1,
      path: "report.txt",
      data: Buffer.from("first").toString("base64"),
      expectedVersion: null,
    }
    const saved = await Cloud.write(f.credentials.alice, workspace.workspaceID, change)
    expect(saved.revision).toBe(2)
    expect(await Cloud.write(f.credentials.alice, workspace.workspaceID, change)).toEqual(saved)
    expect((await WorkspaceCatalog.get(workspace.workspaceID, Cloud.scopeID("org", "project"))).content?.revision).toBe(
      1,
    )
    expect(
      await Cloud.read(f.credentials.reader, workspace.workspaceID, { path: "report.txt", offset: 0, length: 20 }),
    ).toMatchObject({ data: Buffer.from("first").toString("base64"), size: 5 })
    await expect(
      Cloud.write(f.credentials.alice, workspace.workspaceID, { ...change, operationID: "stale" }),
    ).rejects.toMatchObject({ data: { code: "REVISION_CONFLICT" } })
    await expect(
      Cloud.write(f.credentials.alice, workspace.workspaceID, { ...change, data: "c2Vjb25k" }),
    ).rejects.toMatchObject({ data: { code: "INVALID_REQUEST" } })
    await expect(
      Cloud.write(f.credentials.reader, workspace.workspaceID, { ...change, operationID: "reader" }),
    ).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
    await Resources.grant(
      f.credentials.admin,
      resource.resourceID,
      { kind: "project", id: "project" },
      { expectedRevision: 1, enabled: false },
    )
    await expect(
      Cloud.read(f.credentials.alice, workspace.workspaceID, { path: "report.txt", offset: 0, length: 1 }),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } })
    await expect(Cloud.write(f.credentials.alice, workspace.workspaceID, change)).rejects.toMatchObject({
      data: { code: "NOT_FOUND" },
    })
    expect(await Storage.count({ prefix: ["organization", "cloud", "workspaces"] })).toBe(1)
  })
})

test("cloud Environment bindings share canonical lifecycle without exposing infrastructure profiles", async () => {
  await using f = await fixture()
  await f.run(async () => {
    const resource = await Resources.create(f.credentials.admin, {
      name: "Execution",
      scope: { kind: "organization" },
      configuration: { protocol: "environment", profile: "standard" },
      credential: { kind: "none" },
    })
    await Resources.grant(
      f.credentials.admin,
      resource.resourceID,
      { kind: "account", id: "alice" },
      { expectedRevision: 0, enabled: true },
    )
    const descriptors = await Resources.available(f.credentials.alice, "project", { limit: 10 })
    expect(descriptors.items[0]?.definition).toEqual({ protocol: "environment" })
    const input = {
      resourceID: resource.resourceID,
      projectID: "project",
      requestID: "create-compute",
      name: "Task execution",
    }
    const environment = await Cloud.createEnvironment(f.credentials.alice, input)
    expect(environment).toMatchObject({ state: "idle", generation: 0, activeUses: 0 })
    expect(await Cloud.createEnvironment(f.credentials.alice, input)).toEqual(environment)
    expect(await Storage.count({ prefix: ["organization", "cloud", "environments"] })).toBe(1)
    await expect(Cloud.getEnvironment(f.credentials.bob, environment.environmentID)).rejects.toMatchObject({
      data: { code: "NOT_FOUND" },
    })
    await Resources.grant(
      f.credentials.admin,
      resource.resourceID,
      { kind: "account", id: "alice" },
      { expectedRevision: 1, enabled: false },
    )
    await expect(Cloud.getEnvironment(f.credentials.alice, environment.environmentID)).rejects.toMatchObject({
      data: { code: "NOT_FOUND" },
    })
  })
})

test("HTTP cloud writes retain operation identities and reject revoked reads", async () => {
  await using f = await fixture()
  const resource = await f.run(async () => {
    const resource = await Resources.create(f.credentials.admin, {
      name: "Files",
      scope: { kind: "project", projectID: "project" },
      configuration: { protocol: "workspace-storage", profile: "standard" },
      credential: { kind: "none" },
    })
    await Resources.grant(
      f.credentials.admin,
      resource.resourceID,
      { kind: "project", id: "project" },
      { expectedRevision: 0, enabled: true },
    )
    return resource
  })
  const request = (route: string, body: unknown) =>
    fetch(new URL("/org/v1" + route, f.baseUrl), {
      method: "POST",
      headers: {
        ...f.headers("alice"),
        origin: "https://organization.example",
        "x-csrf-token": "f".repeat(64),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    })
  const created = await request("/cloud/workspaces", {
    resourceID: resource.resourceID,
    projectID: "project",
    requestID: "http-create",
    name: "HTTP files",
  })
  expect(created.status).toBe(200)
  const workspace = (await created.json()) as { workspaceID: string }
  const bytes = Buffer.alloc(100_000, 0x61)
  const input = {
    operationID: "http-write",
    path: "large.bin",
    expectedRevision: 1,
    data: bytes.toString("base64"),
    expectedVersion: null,
  }
  const saved = await request(`/cloud/workspaces/${workspace.workspaceID}/write`, input)
  expect(saved.status).toBe(200)
  expect(((await saved.json()) as { revision: number }).revision).toBe(2)
  expect((await request(`/cloud/workspaces/${workspace.workspaceID}/write`, input)).status).toBe(200)
  await f.run(() =>
    Resources.grant(
      f.credentials.admin,
      resource.resourceID,
      { kind: "project", id: "project" },
      { expectedRevision: 1, enabled: false },
    ),
  )
  expect(
    (await request(`/cloud/workspaces/${workspace.workspaceID}/read`, { path: "large.bin", offset: 0, length: 10 }))
      .status,
  ).toBe(404)
})
