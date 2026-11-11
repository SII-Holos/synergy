import { expect, test } from "bun:test"
import path from "node:path"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk"
import { OrganizationReadProtocol as Read } from "@ericsanchezok/synergy-organization-protocol"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { prepareMemberHome } from "../src/home"
import { enrollMemberRuntime } from "../src/enrollment"
import { readMemberRegistration } from "../src/registration"
import { openMemberRuntime } from "../src/runtime"
import { fixture } from "./support/organization"

test("generated native and organization clients read one private history through the same dispatcher", async () => {
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
  const registration = (await readMemberRegistration(member.home, member.identity))!
  const project = (
    await service.client.orgProjects.create(
      { orgProjectCreate: { name: "Private read", description: "" } },
      { headers: service.headers, throwOnError: true },
    )
  ).data
  const online = Promise.withResolvers<void>()
  service.interceptFrames((_socket, frame) => {
    if (JSON.parse(String(frame)).type === "heartbeat") online.resolve()
    return false
  })
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = probe.port!
  await probe.stop(true)
  await using runtime = await openMemberRuntime({
    home: member.home,
    identity: member.identity,
    ca: service.ca,
    listen: { port, token: "a".repeat(64) },
  })
  const timer = setTimeout(() => online.reject(new Error("The private Runtime did not connect")), 3000)
  try {
    await online.promise
  } finally {
    clearTimeout(timer)
  }
  const created = (
    await service.client.orgSessions.create(
      {
        orgCommandCreateRequest: {
          schemaVersion: 1,
          orgID: member.identity.orgID,
          projectID: project.projectID,
          runtimeID: registration.runtimeID,
          requestID: "read-create",
          creation: { operation: "create", title: "Private original" },
        },
      },
      { headers: service.headers, throwOnError: true },
    )
  ).data
  const sessionID = created.effect.sessionID
  const messageID = "msg_private_original"
  const partID = "prt_private_original"
  const text = "Native private evidence 🌏会話\n".repeat(1200)
  await runtime.run(async () => {
    const scope = (await Scope.fromID(project.projectID))!
    await ScopeContext.provide({
      scope,
      workspace: null,
      fn: async () => {
        await Session.updateMessage({
          id: messageID,
          sessionID,
          role: "user",
          agent: "general",
          model: { providerID: "fixture", modelID: "fixture" },
          isRoot: true,
          rootID: messageID,
          time: { created: 1 },
        })
        await Session.updatePart({ id: partID, sessionID, messageID, type: "text", text })
        await Session.flushPartWrites(sessionID)
      },
    })
  })
  const client = createSynergyClient({
    baseUrl: `http://127.0.0.1:${port}`,
    headers: { authorization: `Bearer ${"a".repeat(64)}` },
  })
  const query = Read.Query.parse({ operation: "timeline", rootSessionID: sessionID, limit: 1 })
  const local = Read.Result.parse(
    (await client.orgLocalSession.read({ orgPrivateReadQuery: query }, { throwOnError: true })).data,
  )
  const remote = Read.Result.parse(
    (
      await service.client.orgSessionRead.read(
        { sessionID, orgPrivateReadQuery: query },
        { headers: service.headers, throwOnError: true },
      )
    ).data,
  )
  expect(Read.matches(query, remote, local.binding)).toBeTrue()
  expect(local.operation === "timeline" && local.items[0]?.messageID).toBe(messageID)
  expect(remote.operation === "timeline" && remote.items).toEqual(local.operation === "timeline" && local.items)
  const field = Read.Query.parse({
    operation: "partContent",
    rootSessionID: sessionID,
    messageID,
    partID,
    field: "text",
    offset: 1,
    length: 4096,
  })
  let content: Read.Result | undefined
  for (let attempt = 0; attempt < 50; attempt++) {
    content = Read.Result.parse(
      (await client.orgLocalSession.read({ orgPrivateReadQuery: field }, { throwOnError: true })).data,
    )
    if (content.operation === "partContent" && content.state === "ready") break
    expect(Read.matches(field, content, local.binding)).toBeTrue()
    await Bun.sleep(10)
  }
  if (content?.operation !== "partContent" || content.state !== "ready")
    throw new Error("Native preparation did not complete")
  const forwarded = Read.Result.parse(
    (
      await service.client.orgSessionRead.read(
        { sessionID, orgPrivateReadQuery: field },
        { headers: service.headers, throwOnError: true },
      )
    ).data,
  )
  expect(Read.matches(field, forwarded, local.binding)).toBeTrue()
  if (forwarded.operation !== "partContent" || forwarded.state !== "ready")
    throw new Error("Expected an available private field")
  expect(Buffer.from(forwarded.chunk!.data, "base64url")).toEqual(Buffer.from(text).subarray(1, 4097))
  expect(forwarded.value.version).toBe(content.value.version)
  expect(
    (await service.client.orgSessions.get({ sessionID }, { headers: service.headers, throwOnError: true })).data
      .shareState,
  ).toBe("private")
  expect(
    (
      await fetch(`http://127.0.0.1:${port}/organization/session/read`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(query),
      })
    ).status,
  ).toBe(401)
  expect(JSON.stringify(remote)).not.toContain(member.home)
}, 15_000)
