import { expect, test } from "bun:test"
import { OrganizationCloudProtocol as Cloud } from "@ericsanchezok/synergy-organization-protocol"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { organizationOpenApi } from "../src/http"
import { resourceFixture } from "./support/resource-native"

for (const kind of ["workspaces", "environments"] as const) {
  test(`generated ${kind} catalogs page authorized HTTP identities without allocating compute`, async () => {
    await using f = await resourceFixture()
    const selected = kind === "workspaces" ? f.workspace : f.environment
    const originalID = "workspaceID" in selected ? selected.workspaceID : selected.environmentID
    const created = await f.owner.request("POST", `/cloud/${kind}`, {
      projectID: selected.projectID,
      resourceID: selected.resourceID,
      requestID: `second-${kind}-catalog-entry`,
      name: "Second catalog entry",
    })
    expect(created.status).toBe(200)
    const second =
      kind === "workspaces"
        ? Cloud.Workspace.parse(await created.json())
        : Cloud.Environment.parse(await created.json())
    const secondID = "workspaceID" in second ? second.workspaceID : second.environmentID
    const cookie = (await f.owner.login("owner")).headers.get("set-cookie")?.split(";")[0]
    if (!cookie) throw new Error("Catalog owner has no actual browser login cookie")
    const requests: Array<{
      pathname: string
      resourceID: string | null
      limit: string | null
      cursor: string | null
    }> = []
    const client = createOrganizationClient({
      baseUrl: "https://organization.example",
      headers: { origin: "https://organization.example", cookie },
      fetch: Object.assign(
        (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init)
          const url = new URL(request.url)
          requests.push({
            pathname: url.pathname,
            resourceID: url.searchParams.get("resourceID"),
            limit: url.searchParams.get("limit"),
            cursor: url.searchParams.get("cursor"),
          })
          return f.source.service.fetch(request)
        },
        { preconnect: fetch.preconnect },
      ),
    })
    const pathname = `/org/v1/projects/${selected.projectID}/cloud/${kind}`
    const input = { projectID: selected.projectID, resourceID: selected.resourceID }
    async function list(limit: number, cursor?: string) {
      const parameters = { ...input, limit, cursor }
      const result =
        kind === "workspaces"
          ? await client.orgCloudWorkspaces.list(parameters)
          : await client.orgCloudEnvironments.list(parameters)
      expect(requests.at(-1)).toEqual({
        pathname,
        resourceID: selected.resourceID,
        limit: String(limit),
        cursor: cursor ?? null,
      })
      return result
    }
    async function page(limit: number, cursor?: string) {
      const result = await list(limit, cursor)
      expect(f.allocations).toBe(0)
      expect(result.response.status).toBe(200)
      const value =
        kind === "workspaces" ? Cloud.WorkspacePage.parse(result.data) : Cloud.EnvironmentPage.parse(result.data)
      expect(
        value.items.every((item) => item.projectID === selected.projectID && item.resourceID === selected.resourceID),
      ).toBe(true)
      return {
        cursor: value.cursor,
        ids: value.items.map((item) => ("workspaceID" in item ? item.workspaceID : item.environmentID)),
      }
    }
    const first = await page(1)
    expect(first.ids).toHaveLength(1)
    expect(first.cursor).toBeDefined()
    const next = await page(1, first.cursor)
    expect(next.ids).toHaveLength(1)
    expect(next.cursor).toBeUndefined()
    expect([...first.ids, ...next.ids].sort()).toEqual([originalID, secondID].sort())
    const full = await page(100)
    expect(full.ids.sort()).toEqual([originalID, secondID].sort())
    expect(full.cursor).toBeUndefined()
    for (const limit of [0, 101]) {
      const result = await list(limit)
      expect(result.response.status).toBe(400)
      expect(result.error).toMatchObject({ code: "INVALID_REQUEST" })
    }
    const route = `/projects/${selected.projectID}/cloud/${kind}?resourceID=${selected.resourceID}&limit=1`
    const unknown = await f.owner.request("GET", route + "&unexpected=1")
    expect(unknown.status).toBe(400)
    expect(await unknown.json()).toMatchObject({ code: "INVALID_REQUEST" })
    expect((await f.source.client().request("GET", route)).status).toBe(401)
    const revoked = await f.owner.request(
      "PUT",
      `/resources/${selected.resourceID}/grants/project/${selected.projectID}`,
      { expectedRevision: 1, enabled: false },
    )
    expect(revoked.status).toBe(200)
    const denied = await list(1)
    expect(denied.response.status).toBe(404)
    expect(denied.error).toMatchObject({ code: "NOT_FOUND" })
    expect(f.allocations).toBe(0)
  })
}

test("mounted cloud catalog operations retain their original selector and pagination metadata", async () => {
  const spec = await organizationOpenApi()
  for (const [kind, operationId, schema] of [
    ["workspaces", "orgCloudWorkspaces.list", "OrgCloudWorkspacePage"],
    ["environments", "orgCloudEnvironments.list", "OrgCloudEnvironmentPage"],
  ]) {
    const operation = spec.paths?.[`/org/v1/projects/{projectID}/cloud/${kind}`]?.get
    expect(operation).toMatchObject({
      operationId,
      responses: {
        "200": { content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } } },
      },
    })
    const parameters = operation?.parameters?.map((parameter) =>
      "in" in parameter ? { ...parameter, required: parameter.required ?? false } : parameter,
    )
    expect(parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ in: "path", name: "projectID", required: true }),
        expect.objectContaining({ in: "query", name: "resourceID", required: true }),
        expect.objectContaining({ in: "query", name: "limit", required: false }),
        expect.objectContaining({ in: "query", name: "cursor", required: false }),
      ]),
    )
  }
})
