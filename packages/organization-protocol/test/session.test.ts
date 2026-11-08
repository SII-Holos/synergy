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
