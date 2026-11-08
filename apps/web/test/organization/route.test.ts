import { expect, test } from "bun:test"
import { organizationRoute, parseOrganizationRoute } from "../../src/organization/route"

test("organization routes bind account and deployment and reject partial or foreign paths", () => {
  const identity = {
    kind: "organization",
    orgID: "org-a",
    accountID: "account-a",
    deploymentIncarnation: "deployment-a",
  } as const
  const route = organizationRoute(identity, "project-a", "/synergy")
  expect(parseOrganizationRoute(route, "/synergy")).toEqual({ kind: "organization", identity, projectID: "project-a" })
  expect(parseOrganizationRoute(organizationRoute(identity))).toEqual({ kind: "organization", identity })
  expect(parseOrganizationRoute("/synergy/organization/connect", "/synergy")).toEqual({ kind: "connect" })
  for (const path of [
    "/synergy/aG9tZQ/session",
    "/other/organization/connect",
    "/synergy/organization",
    "/synergy/organization/a/b",
    "/synergy/organization/a/b/c/projects/p/extra",
    "/synergy/organization/a/%2E%2E/c",
  ])
    expect(parseOrganizationRoute(path, "/synergy")).toBeUndefined()
})
