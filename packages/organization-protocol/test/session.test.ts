import { expect, test } from "bun:test"
import { OrganizationSessionProtocol as Protocol } from "../src/index"

test("Session binding is strict, versioned and independent of local paths or display names", () => {
  const binding = {
    schemaVersion: 1,
    orgID: "org-a",
    projectID: "project-a",
    creatorID: "account-a",
    driverRuntimeID: "runtime-a",
    bindingEpoch: 1,
  } satisfies Protocol.Binding
  expect(Protocol.Binding.parse(binding)).toEqual(binding)
  for (const value of [
    { ...binding, schemaVersion: 2 },
    { ...binding, bindingEpoch: 0 },
    { ...binding, bindingEpoch: Number.MAX_SAFE_INTEGER + 1 },
    { ...binding, creatorID: undefined },
    { ...binding, projectID: "../another" },
    { ...binding, localPath: "/private" },
    { ...binding, title: "Private conversation" },
  ])
    expect(Protocol.Binding.safeParse(value).success).toBe(false)
})

test("directory views contain bounded identities and explicit permissions without private content", () => {
  const metadata: Protocol.Metadata = {
    sessionID: "session-a",
    projectID: "project-a",
    creatorID: "account-a",
    driverRuntimeID: "runtime-a",
    bindingEpoch: 1,
    createdAt: 1,
    shareState: "private",
    resourceIDs: ["resource-a"],
    executionGrantIDs: ["grant-a"],
  }
  const view = { ...metadata, permissions: { read: true as const, execute: false, stop: false } }
  expect(Protocol.View.parse(view)).toEqual(view)
  for (const extra of [
    { title: "Private title" },
    { messages: [] },
    { tools: [] },
    { localPath: "/private" },
    { artifacts: [] },
    { nextBindingEpoch: 2 },
    { resourceIDs: ["../resource"] },
    { permissions: { read: true, execute: true, role: "owner" } },
  ])
    expect(Protocol.View.safeParse({ ...view, ...extra }).success).toBe(false)
  expect(Protocol.Capacity.parse({ privateSessions: 1, sharedSessions: 2 })).toEqual({
    privateSessions: 1,
    sharedSessions: 2,
  })
  expect(
    Protocol.Capacity.safeParse({ privateSessions: 1, sharedSessions: 2, sessionIDs: ["session-a"] }).success,
  ).toBe(false)
})
