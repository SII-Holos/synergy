import { expect, test } from "bun:test"
import { OrganizationProjects as Projects } from "../src/projects"
import { directoryFixture } from "./support/session-directory"

test("project membership pages expose public identities with current project access and revision", async () => {
  await using f = await directoryFixture()
  const first = await f.run(() => Projects.members(f.credentials.reader, "project", { limit: 2 }))
  expect(first.items.map((item) => item.accountID)).toEqual(["alice", "bob"])
  expect(first.items[0]).toEqual({ accountID: "alice", displayName: "alice", loginName: "alice", role: "maintainer", state: "active" })
  expect(first.projectRevision).toBe(1)
  expect(first.cursor).toBe("bob")
  const second = await f.run(() => Projects.members(f.credentials.reader, "project", { limit: 2, cursor: first.cursor }))
  expect(second.items.map((item) => item.accountID)).toEqual(["reader"])
  expect(second.cursor).toBeUndefined()
  await expect(f.run(() => Projects.members(f.credentials.outsider, "project", { limit: 2 }))).rejects.toMatchObject({ data: { code: "NOT_FOUND" } })
  const response = await f.request("reader", "/projects/project/members?limit=2")
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(first)
})

test("member candidates require current management permission and never disclose credential records", async () => {
  await using f = await directoryFixture()
  await expect(f.run(() => Projects.candidates(f.credentials.reader, "project", { limit: 4, q: "out" }))).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
  const result = await f.run(() => Projects.candidates(f.credentials.alice, "project", { limit: 4, q: "out" }))
  expect(result.items).toEqual([{ accountID: "outsider", displayName: "outsider", loginName: "outsider", state: "active" }])
  expect(result.projectRevision).toBe(1)
  await f.run(() => Projects.member(f.credentials.alice, "project", "alice", { expectedRevision: 1, role: null }))
  await expect(f.run(() => Projects.candidates(f.credentials.alice, "project", { limit: 4, q: "out" }))).rejects.toMatchObject({ data: { code: "NOT_FOUND" } })
})
