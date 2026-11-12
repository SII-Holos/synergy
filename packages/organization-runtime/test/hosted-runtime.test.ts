import { expect, test } from "bun:test"
import path from "node:path"
import { OrganizationRuntimeProtocol as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import { EnvironmentProviders } from "@ericsanchezok/synergy-harness/environment/provider"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionTransferOwners as Owners } from "@ericsanchezok/synergy-harness/session/transfer"
import { prepareHostedHome } from "../src/home"
import { enrollHostedRuntime } from "../src/enrollment"
import { openHostedRuntime } from "../src/runtime"
import { fixture } from "./support/organization"

test("a hosted Runtime receives organization-created Sessions with the signed actor as creator", async () => {
  await using service = await fixture()
  const hosted = await prepareHostedHome({
    baseDirectory: path.join(service.root, "hosted"),
    identity: { orgID: service.identity.orgID, hostID: "team-server" },
    origin: service.origin,
  })
  const response = await service.service.fetch(
    new Request("https://organization.example/org/v1/runtimes/hosted", {
      method: "POST",
      headers: { ...service.headers, origin: "https://organization.example", "content-type": "application/json" },
      body: JSON.stringify({ name: "Team server", publicKey: hosted.publicKey }),
    }),
  )
  expect(response.status).toBe(200)
  const ticket = Protocol.Ticket.parse(await response.json())
  const registration = await enrollHostedRuntime({
    home: hosted.home,
    identity: hosted.identity,
    ticket,
    ca: service.ca,
  })
  const online = Promise.withResolvers<void>()
  service.interceptFrames((_socket, frame) => {
    if (Protocol.ClientFrame.parse(JSON.parse(String(frame))).type === "heartbeat") online.resolve()
    return false
  })
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = probe.port!
  await probe.stop(true)
  await using runtime = await openHostedRuntime({
    home: hosted.home,
    identity: hosted.identity,
    ca: service.ca,
    listen: { port, token: "a".repeat(64) },
    environment: { ...process.env, OPENAI_API_KEY: "private", NODE_OPTIONS: "private" },
  })
  const timer = setTimeout(() => online.reject(new Error("Hosted connection did not become ready")), 3_000)
  try {
    await online.promise
  } finally {
    clearTimeout(timer)
  }
  await runtime.run(() => {
    expect(EnvironmentProviders.list()).toEqual([])
    expect(RuntimeContext.current().host.env.OPENAI_API_KEY).toBeUndefined()
    expect(RuntimeContext.current().host.env.NODE_OPTIONS).toBeUndefined()
    expect(
      Owners.compatibility({
        "session-core": 2,
        "session-evidence": 1,
        "session-snapshots": 1,
        "organization-runtime": 3,
        "session-workspaces": 1,
      }),
    ).toEqual([])
  })
  const project = (
    await service.client.orgProjects.create(
      { orgProjectCreate: { name: "Hosted project", description: "" } },
      { headers: service.headers, throwOnError: true },
    )
  ).data
  const created = await service.client.orgSessions.create(
    {
      orgCommandCreateRequest: {
        schemaVersion: 1,
        orgID: hosted.identity.orgID,
        projectID: project.projectID,
        runtimeID: registration.runtimeID,
        requestID: "hosted-create",
        creation: { operation: "create", title: "Hosted work" },
      },
    },
    { headers: service.headers, throwOnError: true },
  )
  expect(created.response.status).toBe(202)
  expect(await runtime.run(() => Session.get(created.data.effect.sessionID))).toMatchObject({
    title: "Hosted work",
    organization: {
      orgID: service.identity.orgID,
      projectID: project.projectID,
      creatorID: service.identity.accountID,
      driverRuntimeID: registration.runtimeID,
    },
  })
})
