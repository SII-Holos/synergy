import { expect, spyOn, test } from "bun:test"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationResourceProtocol as Resource } from "@ericsanchezok/synergy-organization-protocol"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { OrganizationResources as Resources } from "../src/resources"
import { OrganizationRecord as Record } from "../src/storage/records"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { authorize } from "../src/authorization"
import { OrganizationProjects } from "../src/projects"
import { directoryFixture } from "./support/session-directory"

test("generated resource clients preserve revisions, grants and redacted HTTP failures", async () => {
  await using f = await directoryFixture()
  const admin = createOrganizationClient({
    baseUrl: f.baseUrl,
    headers: { ...f.headers("admin"), origin: "https://organization.example", "x-csrf-token": "f".repeat(64) },
  })
  const reader = createOrganizationClient({ baseUrl: f.baseUrl, headers: f.headers("alice") })
  const created = (
    await admin.orgResources.create({ orgResourceCreate: Resource.Create.parse(model()) }, { throwOnError: true })
  ).data
  expect((await admin.orgResources.get({ resourceID: created.resourceID }, { throwOnError: true })).data).toEqual(
    created,
  )
  expect((await admin.orgResources.list({ limit: 1 }, { throwOnError: true })).data.items).toEqual([created])
  await admin.orgResourceGrants.set(
    {
      resourceID: created.resourceID,
      kind: "account",
      subjectID: "alice",
      orgResourceGrantChange: { expectedRevision: 0, enabled: true },
    },
    { throwOnError: true },
  )
  expect(
    (await admin.orgResourceGrants.list({ resourceID: created.resourceID, kind: "account" }, { throwOnError: true }))
      .data.items,
  ).toMatchObject([{ subject: { kind: "account", id: "alice" }, enabled: true }])
  const available = await reader.orgProjectResources.list({ projectID: "project" }, { throwOnError: true })
  expect(available.data.items[0]).toMatchObject({ resourceID: created.resourceID, permissions: { use: true } })
  expect(available.data.items[0]).not.toHaveProperty("configuration")
  const updated = await admin.orgResources.update(
    {
      resourceID: created.resourceID,
      orgResourceChange: {
        expectedRevision: 1,
        name: "Rotated",
        credential: { kind: "bearer", value: "rotated-http-secret" },
      },
    },
    { throwOnError: true },
  )
  expect(updated.data.revision).toBe(2)
  expect(JSON.stringify(updated.data)).not.toContain("rotated-http-secret")
  const stale = await admin.orgResources.update({
    resourceID: created.resourceID,
    orgResourceChange: { expectedRevision: 1, state: "disabled" },
  })
  expect(stale.response.status).toBe(409)
  expect(stale.error).toMatchObject({ code: "REVISION_CONFLICT", currentRevision: 2 })
  const invalid = await fetch(new URL("/org/v1/resources", f.baseUrl), {
    method: "POST",
    headers: {
      ...f.headers("admin"),
      origin: "https://organization.example",
      "x-csrf-token": "f".repeat(64),
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...model(), arbitrary: "secret-that-must-not-be-echoed" }),
  })
  expect(invalid.status).toBe(400)
  expect(await invalid.text()).not.toContain("secret-that-must-not-be-echoed")
})

test("a project resource cannot be selected or granted across its fixed scope", async () => {
  await using f = await directoryFixture()
  await f.run(async () => {
    const other = await OrganizationProjects.create(f.credentials.alice, { name: "Other project", description: "" })
    const resource = await Resources.create(
      f.credentials.admin,
      Resource.Create.parse({
        ...model(),
        scope: { kind: "project", projectID: "project" },
      }),
    )
    await Resources.grant(
      f.credentials.admin,
      resource.resourceID,
      { kind: "account", id: "alice" },
      { expectedRevision: 0, enabled: true },
    )
    expect((await Resources.available(f.credentials.alice, other.projectID, { limit: 50 })).items).toEqual([])
    await expect(
      authorize(f.credentials.alice, "resource.use", { resourceID: resource.resourceID, projectID: other.projectID }),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } })
    await expect(
      Resources.grant(
        f.credentials.admin,
        resource.resourceID,
        { kind: "project", id: other.projectID },
        { expectedRevision: 0, enabled: true },
      ),
    ).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
  })
})

test("supported model and business configurations retain credentials only in their private owner", async () => {
  await using f = await directoryFixture()
  await f.run(async () => {
    const base = model()
    const inputs = [
      {
        ...base,
        configuration: { ...base.configuration, protocol: "anthropic-compatible" },
        credential: { kind: "header", name: "x-api-key", value: "anthropic-fixture-secret" },
      },
      ...["mcp-http", "mcp-sse"].map((protocol) => ({
        ...base,
        configuration: { protocol, endpoint: "https://mcp.example/service" },
        credential: { kind: "bearer", value: "mcp-fixture-secret" },
      })),
      {
        ...base,
        configuration: { protocol: "fixed-http", method: "POST", endpoint: "https://business.example/execute" },
        credential: { kind: "header", name: "X-Api-Key", value: "http-fixture-secret" },
      },
    ]
    for (const input of inputs) {
      const result = await Resources.create(f.credentials.admin, Resource.Create.parse(input))
      expect(JSON.stringify(result)).not.toContain(input.credential.value)
      expect(result.kind).toBe(input.configuration.protocol === "anthropic-compatible" ? "model" : "connection")
      await Resources.grant(
        f.credentials.admin,
        result.resourceID,
        { kind: "project", id: "project" },
        { expectedRevision: 0, enabled: true },
      )
    }
    expect((await Resources.available(f.credentials.alice, "project", { limit: 50 })).items).toHaveLength(4)
    await expect(
      Resources.create(
        f.credentials.admin,
        Resource.Create.parse({
          ...base,
          credential: { kind: "header", name: "x-api-key", value: "wrong-credential" },
        }),
      ),
    ).rejects.toMatchObject({ data: { code: "INVALID_REQUEST" } })
    await expect(
      Resources.create(
        f.credentials.admin,
        Resource.Create.parse({
          ...base,
          configuration: { ...base.configuration, protocol: "anthropic-compatible" },
        }),
      ),
    ).rejects.toMatchObject({ data: { code: "INVALID_REQUEST" } })
    expect((await Resources.list(f.credentials.admin, { limit: 50 })).items).toHaveLength(4)
  })
})

test("resource selection combines current project roles with explicit grants and immutable ownership", async () => {
  await using f = await directoryFixture()
  await f.run(async () => {
    const resource = await Resources.create(f.credentials.admin, Resource.Create.parse(model()))
    for (const id of ["alice", "reader", "owner"])
      await Resources.grant(
        f.credentials.admin,
        resource.resourceID,
        { kind: "account", id },
        { expectedRevision: 0, enabled: true },
      )
    for (const id of ["reader", "owner"]) {
      expect(
        (await Resources.available(f.credentials[id], "project", { limit: 50 })).items[0].permissions.use,
      ).toBeFalse()
      await expect(
        authorize(f.credentials[id], "resource.use", { resourceID: resource.resourceID, projectID: "project" }),
      ).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
    }
    expect(
      (await authorize(f.credentials.alice, "resource.use", { resourceID: resource.resourceID, projectID: "project" }))
        .view?.permissions.use,
    ).toBeTrue()
    for (const [action, credentials] of [
      ["resource.manage", f.credentials.alice],
      ["unknown.action", f.credentials.admin],
    ] as const)
      await expect(authorize(credentials, action, { resourceID: resource.resourceID })).rejects.toMatchObject({
        data: { code: "PERMISSION_DENIED" },
      })
    await Storage.update<Record.Account>(Keys.account("foreign"), (value) => {
      value.role = "admin"
    })
    await expect(Resources.get(f.credentials.foreign, resource.resourceID)).rejects.toMatchObject({
      data: { code: "NOT_FOUND" },
    })
    await Resources.update(f.credentials.admin, resource.resourceID, { expectedRevision: 1, state: "disabled" })
    expect(
      (await Resources.available(f.credentials.alice, "project", { limit: 50 })).items[0].permissions.use,
    ).toBeFalse()
    await Resources.update(f.credentials.admin, resource.resourceID, { expectedRevision: 2, state: "enabled" })
    await Storage.update(Keys.project("project"), (value: { state: string }) => {
      value.state = "archived"
    })
    await expect(
      authorize(f.credentials.alice, "resource.use", { resourceID: resource.resourceID, projectID: "project" }),
    ).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
    await Storage.remove(Keys.projectMember("project", "alice"))
    await expect(Resources.available(f.credentials.alice, "project", { limit: 50 })).rejects.toMatchObject({
      data: { code: "NOT_FOUND" },
    })
    await Storage.update<Record.Account>(Keys.account("reader"), (value) => {
      value.state = "removed"
      value.authRevision++
    })
    await expect(Resources.available(f.credentials.reader, "project", { limit: 50 })).rejects.toMatchObject({
      data: { code: "AUTHENTICATION_REQUIRED" },
    })
    await expect(
      Resources.update(f.credentials.admin, resource.resourceID, {
        expectedRevision: 3,
        configuration: { protocol: "fixed-http", method: "POST", endpoint: "https://connection.example/action" },
      }),
    ).rejects.toMatchObject({ data: { code: "INVALID_REQUEST" } })
  })
})

test("resource and grant revisions, secrets and authorized indexes commit together", async () => {
  await using f = await directoryFixture()
  await f.run(async () => {
    await expect(
      Storage.transaction(async () => {
        await Resources.create(f.credentials.admin, Resource.Create.parse(model()))
        throw new Error("Creation rolled back")
      }),
    ).rejects.toThrow("Creation rolled back")
    expect(await Resources.list(f.credentials.admin, { limit: 50 })).toEqual({ items: [], cursor: undefined })
    expect(await Storage.count({ prefix: ["organization", "resource-secrets"] })).toBe(0)
    const resource = await Resources.create(f.credentials.admin, Resource.Create.parse(model()))
    await expect(
      Storage.transaction(async () => {
        await Resources.grant(
          f.credentials.admin,
          resource.resourceID,
          { kind: "account", id: "alice" },
          { expectedRevision: 0, enabled: true },
        )
        throw new Error("Grant rolled back")
      }),
    ).rejects.toThrow("Grant rolled back")
    expect((await Resources.available(f.credentials.alice, "project", { limit: 50 })).items).toEqual([])
    expect((await Resources.grants(f.credentials.admin, resource.resourceID, "account", { limit: 50 })).items).toEqual(
      [],
    )
    const rotated = await Resources.update(f.credentials.admin, resource.resourceID, {
      expectedRevision: 1,
      credential: { kind: "bearer", value: "rotated-fixture-secret" },
    })
    expect(rotated.revision).toBe(2)
    const row = (await Record.read(Record.Resource, Keys.resource(resource.orgID, resource.resourceID)))!
    const secret = await Record.read(Record.ResourceSecret, Keys.resourceSecret(row.secretID!))
    expect(secret?.credential).toEqual({ kind: "bearer", value: "rotated-fixture-secret" })
    await expect(
      Resources.update(f.credentials.admin, resource.resourceID, {
        expectedRevision: 1,
        credential: { kind: "bearer", value: "stale-fixture-secret" },
      }),
    ).rejects.toMatchObject({ data: { code: "REVISION_CONFLICT", currentRevision: 2 } })
    expect(await Record.read(Record.ResourceSecret, Keys.resourceSecret(row.secretID!))).toEqual(secret)
    await Resources.update(f.credentials.admin, resource.resourceID, {
      expectedRevision: 2,
      credential: { kind: "none" },
    })
    expect(await Record.read(Record.ResourceSecret, Keys.resourceSecret(row.secretID!))).toBeUndefined()
    const subject = { kind: "account" as const, id: "alice" }
    await Resources.grant(f.credentials.admin, resource.resourceID, subject, { expectedRevision: 0, enabled: true })
    await Resources.grant(f.credentials.admin, resource.resourceID, subject, { expectedRevision: 1, enabled: false })
    await expect(
      Resources.grant(f.credentials.admin, resource.resourceID, subject, { expectedRevision: 0, enabled: true }),
    ).rejects.toMatchObject({ data: { code: "REVISION_CONFLICT", currentRevision: 2 } })
    await expect(
      Resources.grant(
        f.credentials.admin,
        resource.resourceID,
        { kind: "account", id: "foreign" },
        { expectedRevision: 0, enabled: true },
      ),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } })
  })
})

test("resource pages merge authorized account and project indexes without hydrating unrelated records", async () => {
  await using f = await directoryFixture()
  await f.run(async () => {
    const expected: string[] = []
    await Storage.transaction(async () => {
      for (let index = 0; index < 130; index++) {
        const resource = await Resources.create(
          f.credentials.admin,
          Resource.Create.parse({
            ...model(),
            name: "Resource " + index,
            credential: { kind: "none" },
            scope: index % 2 ? { kind: "organization" } : { kind: "project", projectID: "project" },
          }),
        )
        await Resources.grant(
          f.credentials.admin,
          resource.resourceID,
          { kind: "account", id: "bob" },
          { expectedRevision: 0, enabled: true },
        )
        if (index % 2 === 0)
          await Resources.grant(
            f.credentials.admin,
            resource.resourceID,
            { kind: "account", id: "alice" },
            { expectedRevision: 0, enabled: true },
          )
        if (index % 3 === 0)
          await Resources.grant(
            f.credentials.admin,
            resource.resourceID,
            { kind: "project", id: "project" },
            { expectedRevision: 0, enabled: true },
          )
        if (index % 2 === 0 || index % 3 === 0) expected.push(resource.resourceID)
      }
    })
    const actual: string[] = []
    let cursor: string | undefined
    using reads = spyOn(Storage, "readMany")
    do {
      reads.mockClear()
      const page = await Resources.available(f.credentials.alice, "project", { limit: 17, cursor })
      actual.push(...page.items.map((item) => item.resourceID))
      const keys = reads.mock.calls.flatMap(([keys]) => keys)
      expect(keys.filter((key) => key[0] === "organization" && key[1] === "resources").length).toBeLessThanOrEqual(17)
      expect(keys.some((key) => key[0] === "organization" && key[1] === "resource-secrets")).toBeFalse()
      cursor = page.cursor
    } while (cursor)
    expect(actual).toEqual(expected.sort())
    const duplicate = actual[0]
    const grants = await Resources.grants(f.credentials.admin, duplicate, "project", { limit: 1 })
    if (grants.items.length) expect(grants.items[0].subject.id).toBe("project")
  })
})

function model() {
  return {
    name: "Shared model",
    scope: { kind: "organization" },
    configuration: {
      protocol: "openai-compatible",
      endpoint: "https://model.example/v1",
      model: { id: "fixture-model", name: "Fixture model", limit: { context: 8192, output: 2048 } },
    },
    credential: { kind: "bearer", value: "organization-fixture-secret" },
  }
}

test("administrators configure resource secrets while members receive only authorized descriptors", async () => {
  await using f = await directoryFixture()
  async function request(account: string, method: string, route: string, body?: unknown) {
    return fetch(new URL("/org/v1" + route, f.baseUrl), {
      method,
      headers: {
        ...f.headers(account),
        origin: "https://organization.example",
        "x-csrf-token": "f".repeat(64),
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }
  expect((await request("alice", "POST", "/resources", model())).status).toBe(403)
  const created = await request("admin", "POST", "/resources", model())
  expect(created.status).toBe(200)
  const text = await created.text()
  expect(text).not.toContain("organization-fixture-secret")
  const resource = JSON.parse(text) as { resourceID: string; revision: number; credential: { kind: string } }
  expect(resource.credential).toEqual({ kind: "bearer" })
  expect((await f.request("alice", "/resources")).status).toBe(403)
  expect(await (await f.request("alice", "/projects/project/resources")).json()).toEqual({ items: [] })
  const granted = await request("admin", "PUT", "/resources/" + resource.resourceID + "/grants/account/alice", {
    expectedRevision: 0,
    enabled: true,
  })
  expect(granted.status).toBe(200)
  expect(await granted.json()).toMatchObject({ revision: 1, enabled: true })
  const visible = await f.request("alice", "/projects/project/resources")
  expect(visible.status).toBe(200)
  const payload = await visible.text()
  expect(payload).not.toContain("model.example")
  expect(payload).not.toContain("organization-fixture-secret")
  expect(JSON.parse(payload)).toMatchObject({
    items: [{ resourceID: resource.resourceID, permissions: { use: true } }],
  })
  expect(await (await f.request("bob", "/projects/project/resources")).json()).toEqual({ items: [] })
  await f.restart()
  expect(await (await f.request("alice", "/projects/project/resources")).json()).toMatchObject({
    items: [{ resourceID: resource.resourceID }],
  })
  expect(
    (
      await request("admin", "PUT", "/resources/" + resource.resourceID + "/grants/account/alice", {
        expectedRevision: 1,
        enabled: false,
      })
    ).status,
  ).toBe(200)
  expect(await (await f.request("alice", "/projects/project/resources")).json()).toEqual({ items: [] })
})
