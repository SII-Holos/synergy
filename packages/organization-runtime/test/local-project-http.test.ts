import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk"
import { OrganizationLocalProjectProtocol } from "@ericsanchezok/synergy-organization-protocol"
import { prepareMemberHome } from "../src/home"
import { enrollMemberRuntime } from "../src/enrollment"
import { openMemberRuntime } from "../src/runtime"
import { fixture } from "./support/organization"

test("mounted local project routes retain OpenAPI operations and loopback authentication", async () => {
  await using service = await fixture()
  const member = await prepareMemberHome({
    baseDirectory: path.join(service.root, "members"),
    identity: service.identity,
    origin: service.origin,
  })
  await enrollMemberRuntime({
    home: member.home,
    identity: member.identity,
    ticket: await service.ticket(member.identity.deviceID, member.publicKey),
    ca: service.ca,
  })
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = probe.port!
  await probe.stop(true)
  await using runtime = await openMemberRuntime({
    home: member.home,
    identity: member.identity,
    ca: service.ca,
    listen: { port, token: "c".repeat(64) },
  })
  const { Server } = await import("@ericsanchezok/synergy-server/server/server")
  const spec = await runtime.run(() => Server.openapi())
  expect(spec.paths["/organization-local-project/{projectID}"]?.get?.operationId).toBe("orgLocalProject.get")
  expect(spec.paths["/organization-local-project/{projectID}"]?.post?.operationId).toBe("orgLocalProject.bind")
  expect((await fetch(`http://127.0.0.1:${port}/organization-local-project/project-native`)).status).toBe(401)
  const client = createSynergyClient({
    baseUrl: `http://127.0.0.1:${port}`,
    headers: { authorization: `Bearer ${"c".repeat(64)}` },
  })
  const projectID = "project-native"
  const initial = (await client.orgLocalProject.get({ projectID }, { throwOnError: true })).data
  expect(OrganizationLocalProjectProtocol.Summary.parse(initial).binding).toBeNull()
  const directory = path.join(service.root, "native-http")
  await fs.mkdir(directory)
  const orgLocalProjectBind = { requestID: "http-bind", expectedRevision: initial.revision, directory }
  const first = await client.orgLocalProject.bind({ projectID, orgLocalProjectBind }, { throwOnError: true })
  expect(first.data.binding?.label).toBe("native-http")
  expect(JSON.stringify(first.data)).not.toContain(directory)
  expect((await client.orgLocalProject.get({ projectID }, { throwOnError: true })).data).toEqual(first.data)
  expect((await client.orgLocalProject.bind({ projectID, orgLocalProjectBind }, { throwOnError: true })).data).toEqual(
    first.data,
  )
  const stale = await client.orgLocalProject.bind({
    projectID,
    orgLocalProjectBind: { ...orgLocalProjectBind, requestID: "http-stale" },
  })
  expect(stale.response.status).toBe(409)
  expect(stale.error).toMatchObject({ code: "REVISION_CONFLICT", outcome: "not_dispatched" })
})
