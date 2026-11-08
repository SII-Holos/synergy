import { expect, spyOn, test } from "bun:test"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationSessionProtocol as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { OrganizationRecord as Record } from "../src/storage/records"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { OrganizationSessionDirectory as Directory } from "../src/session-directory"
import { authorize } from "../src/authorization"
import { directoryFixture } from "./support/session-directory"
import { fixture } from "./support/organization"

test("the organization exposes an authorized empty Session directory and rejects incomplete creation", async () => {
  await using f = await fixture()
  const owner = await f.initialize()
  const created = await owner.request("POST", "/projects", { name: "Private work" })
  const project = (await created.json()) as { projectID: string }
  const response = await owner.request("GET", `/projects/${project.projectID}/sessions`)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ items: [] })
  const capacity = await owner.request("GET", "/organization/session-capacity")
  expect(capacity.status).toBe(200)
  expect(await capacity.json()).toEqual({ privateSessions: 0, sharedSessions: 0 })
  expect((await owner.request("POST", "/sessions", { projectID: project.projectID })).status).toBe(400)
})

test("private metadata reservation derives ownership and joins the surrounding admission transaction", async () => {
  await using f = await directoryFixture()
  await f.run(async () => {
    const input = { projectID: "project", runtimeID: "runtime-alice", sessionID: "session-a" }
    await expect(
      Storage.transaction(async () => {
        await Directory.reservePrivate(f.credentials.alice, input)
        throw new Error("Admission rolled back")
      }),
    ).rejects.toThrow("Admission rolled back")
    expect(await Directory.list(f.credentials.alice, "project", { limit: 10 })).toEqual({ items: [] })
    expect(await Directory.capacity(f.credentials.owner)).toEqual({ privateSessions: 0, sharedSessions: 0 })
    const row = await Directory.reservePrivate(f.credentials.alice, input)
    expect(row).toMatchObject({
      creatorID: "alice",
      orgID: "org",
      bindingEpoch: 1,
      nextBindingEpoch: 2,
      shareState: "private",
    })
    expect(row.resourceIDs).toEqual([])
    expect(row.executionGrantIDs).toEqual([])
    expect(Record.SessionDirectory.safeParse({ ...row, title: "Private title" }).success).toBe(false)
    expect(Record.SessionDirectory.safeParse({ ...row, nextBindingEpoch: 1 }).success).toBe(false)
    await expect(Directory.reservePrivate(f.credentials.alice, input)).rejects.toMatchObject({
      data: { code: "REVISION_CONFLICT" },
    })
    await expect(Directory.reservePrivate(f.credentials.alice, { ...input, ...{ creatorID: "bob" } })).rejects.toThrow()
    for (const runtimeID of ["runtime-bob", "runtime-foreign", "missing"])
      await expect(
        Directory.reservePrivate(f.credentials.alice, { ...input, sessionID: "unused", runtimeID }),
      ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } })
    for (const id of ["owner", "admin", "reader"])
      await expect(
        Directory.reservePrivate(f.credentials[id], { ...input, sessionID: "unused", runtimeID: `runtime-${id}` }),
      ).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
    await Storage.update<Record.RuntimeRegistration>(Keys.runtime("runtime-alice"), (draft) => {
      draft.state = "revoked"
    })
    await expect(
      Directory.reservePrivate(f.credentials.alice, { ...input, sessionID: "unused" }),
    ).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
    expect(await Directory.capacity(f.credentials.owner)).toEqual({ privateSessions: 1, sharedSessions: 0 })
  })
  await f.restart()
  const response = await f.request("alice", "/sessions/session-a")
  expect(response.status).toBe(200)
  const retained = Protocol.View.parse(await response.json())
  expect(retained.creatorID).toBe("alice")
  expect(retained.permissions.execute).toBe(true)
  expect("nextBindingEpoch" in retained).toBe(false)
})

test("private Session access always checks the stored project, creator and current membership", async () => {
  await using f = await directoryFixture()
  await f.run(async () => {
    await Directory.reservePrivate(f.credentials.alice, {
      projectID: "project",
      runtimeID: "runtime-alice",
      sessionID: "session-a",
    })
    const forgedTarget = { sessionID: "session-a", projectID: "a-client-cannot-override-this" }
    expect((await authorize(f.credentials.alice, "session.read", forgedTarget)).view.projectID).toBe("project")
    await expect(authorize(f.credentials.alice, "unknown.action", forgedTarget)).rejects.toMatchObject({
      data: { code: "PERMISSION_DENIED" },
    })
  })
  for (const id of ["owner", "admin", "bob", "reader", "outsider", "foreign"]) {
    expect((await f.request(id, "/sessions/session-a")).status).toBe(404)
    expect((await f.request(id, "/sessions/missing")).status).toBe(404)
  }
  expect((await fetch(new URL("/org/v1/sessions/session-a", f.baseUrl))).status).toBe(401)
  await f.run(async () => {
    await Storage.update<{ role: string }>(Keys.projectMember("project", "alice"), (draft) => {
      draft.role = "reader"
    })
    expect((await Directory.get(f.credentials.alice, "session-a")).permissions).toEqual({ read: true, execute: false })
    await expect(authorize(f.credentials.alice, "session.execute", { sessionID: "session-a" })).rejects.toMatchObject({
      data: { code: "PERMISSION_DENIED" },
    })
    await Storage.remove(Keys.projectMember("project", "alice"))
    await expect(Directory.get(f.credentials.alice, "session-a")).rejects.toMatchObject({ data: { code: "NOT_FOUND" } })
  })
  expect((await f.request("alice", "/projects/project/sessions")).status).toBe(404)
  await f.run(async () => {
    await Storage.update<Record.Account>(Keys.account("alice"), (draft) => {
      draft.state = "removed"
      draft.authRevision++
    })
  })
  expect((await f.request("alice", "/sessions/session-a")).status).toBe(401)
  expect((await f.request("bob", "/organization/session-capacity")).status).toBe(403)
})

test("directory pagination starts from visible identities and anonymous capacity never loads private records", async () => {
  await using f = await directoryFixture()
  const expected: string[] = []
  await f.run(() =>
    Storage.transaction(async () => {
      for (let index = 0; index < 128; index++) {
        const sessionID = `session-${String(index).padStart(3, "0")}`
        const id = index % 2 === 0 ? "alice" : "bob"
        const row = await Directory.reservePrivate(f.credentials[id], {
          sessionID,
          projectID: "project",
          runtimeID: `runtime-${id}`,
        })
        const shared = index % 5 === 0
        if (shared) {
          await Storage.write(Keys.session(sessionID), {
            ...row,
            shareState: "shared",
            shareGeneration: 1,
            rowRevision: 1,
          })
          await Storage.remove(Keys.visibleSession("private", "project", sessionID))
          await Storage.write(Keys.visibleSession("shared", "project", sessionID), { sessionID })
        }
        if (id === "alice" || shared) expected.push(sessionID)
      }
      await Storage.write(Keys.session("session-001"), { title: "Foreign private body must never be read" })
    }),
  )
  const original = Storage.readMany
  const observed: string[] = []
  const reader = spyOn(Storage, "readMany").mockImplementation(async <T>(keys: string[][]) => {
    const sessions = keys.filter((key) => key[0] === "organization" && key[1] === "sessions")
    expect(sessions.length).toBeLessThanOrEqual(7)
    observed.push(...sessions.map((key) => key.at(-1)!))
    return original<T>(keys)
  })
  try {
    const actual: string[] = []
    let cursor: string | undefined
    do {
      const response = await f.request(
        "alice",
        `/projects/project/sessions?limit=7${cursor ? `&cursor=${cursor}` : ""}`,
      )
      expect(response.status).toBe(200)
      const page = Protocol.Page.parse(await response.json())
      actual.push(...page.items.map((row) => row.sessionID))
      cursor = page.cursor
    } while (cursor)
    expect(actual).toEqual(expected)
    expect(new Set(observed)).toEqual(new Set(expected))
    const before = observed.length
    const capacity = await f.request("owner", "/organization/session-capacity")
    expect(await capacity.json()).toEqual({ privateSessions: 102, sharedSessions: 26 })
    expect(observed.length).toBe(before)
    const owner = await f.request("owner", "/projects/project/sessions?limit=7")
    const ownerPage = Protocol.Page.parse(await owner.json())
    expect(ownerPage.items.every((row) => row.shareState === "shared" && !row.permissions.execute)).toBe(true)
  } finally {
    reader.mockRestore()
  }
  expect((await f.request("alice", "/projects/project/sessions?limit=0")).status).toBe(400)
  expect((await f.request("alice", "/projects/project/sessions?creatorID=bob")).status).toBe(400)
  await f.run(async () => {
    await Storage.update<{ state: string }>(Keys.project("project"), (draft) => {
      draft.state = "archived"
    })
    expect((await Directory.get(f.credentials.alice, "session-002")).permissions.execute).toBe(false)
    await expect(
      Directory.reservePrivate(f.credentials.alice, {
        projectID: "project",
        runtimeID: "runtime-alice",
        sessionID: "new",
      }),
    ).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
  })
}, 30_000)

test("concurrent reservations cannot claim one Session identity for two creators", async () => {
  await using f = await directoryFixture()
  await f.run(async () => {
    const attempts = await Promise.allSettled(
      ["alice", "bob"].map((id) =>
        Directory.reservePrivate(f.credentials[id], {
          sessionID: "one-session",
          projectID: "project",
          runtimeID: `runtime-${id}`,
        }),
      ),
    )
    const accepted = attempts.filter((entry) => entry.status === "fulfilled")
    expect(accepted.length).toBe(1)
    expect(attempts.filter((entry) => entry.status === "rejected")).toHaveLength(1)
    const creator = accepted[0].value.creatorID
    expect(
      (await Directory.list(f.credentials[creator], "project", { limit: 10 })).items.map((row) => row.sessionID),
    ).toEqual(["one-session"])
    const other = creator === "alice" ? "bob" : "alice"
    expect((await Directory.list(f.credentials[other], "project", { limit: 10 })).items).toEqual([])
    expect(await Directory.capacity(f.credentials.owner)).toEqual({ privateSessions: 1, sharedSessions: 0 })
    await Storage.transaction(async () => {
      await Storage.update<Record.Account>(Keys.account(creator), (draft) => {
        draft.authRevision++
      })
      await expect(
        Directory.reservePrivate(f.credentials[creator], {
          sessionID: "after-revocation",
          projectID: "project",
          runtimeID: `runtime-${creator}`,
        }),
      ).rejects.toMatchObject({ data: { code: "AUTHENTICATION_REQUIRED" } })
    })
    expect(await Directory.capacity(f.credentials.owner)).toEqual({ privateSessions: 1, sharedSessions: 0 })
  })
})

test("generated directory clients preserve authorization and metadata over real HTTP", async () => {
  await using f = await directoryFixture()
  await f.run(() =>
    Directory.reservePrivate(f.credentials.alice, {
      sessionID: "session-a",
      projectID: "project",
      runtimeID: "runtime-alice",
    }),
  )
  const alice = createOrganizationClient({ baseUrl: f.baseUrl, headers: f.headers("alice") })
  const owner = createOrganizationClient({ baseUrl: f.baseUrl, headers: f.headers("owner") })
  const item = (await alice.orgSessions.get({ sessionID: "session-a" }, { throwOnError: true })).data
  expect(item.creatorID).toBe("alice")
  expect(item.permissions).toEqual({ read: true, execute: true })
  expect((await alice.orgSessions.list({ projectID: "project", limit: 1 }, { throwOnError: true })).data.items).toEqual(
    [item],
  )
  expect((await owner.orgSessions.get({ sessionID: "session-a" })).response.status).toBe(404)
  expect((await owner.orgOrganization.sessionCapacity({ throwOnError: true })).data).toEqual({
    privateSessions: 1,
    sharedSessions: 0,
  })
  await f.run(async () => {
    await Storage.update<Record.SessionDirectory>(Keys.session("session-a"), (draft) => {
      draft.handoffID = "handoff-a"
    })
    await expect(authorize(f.credentials.alice, "session.execute", { sessionID: "session-a" })).rejects.toMatchObject({
      data: { code: "PERMISSION_DENIED" },
    })
  })
  expect(
    (await alice.orgSessions.get({ sessionID: "session-a" }, { throwOnError: true })).data.permissions.execute,
  ).toBe(false)
})
