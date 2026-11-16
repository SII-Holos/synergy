import { expect, test } from "bun:test"
import path from "node:path"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk"
import { OrganizationReadProtocol as Read } from "@ericsanchezok/synergy-organization-protocol"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { RolloutArtifact } from "@ericsanchezok/synergy-harness/session/rollout/artifact"
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
  const attachmentID = "prt_private_attachment"
  const toolPartID = "prt_private_tool_attachments"
  const attachmentBytes = Uint8Array.from({ length: 90_001 }, (_, index) => index % 256)
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
        const artifact = await RolloutArtifact.write(
          { kind: "session", scopeID: project.projectID, sessionID },
          (async function* () {
            yield attachmentBytes
          })(),
          "application/octet-stream",
        )
        await Session.updatePart({
          id: attachmentID,
          sessionID,
          messageID,
          type: "attachment",
          artifact,
          filename: "private-file.bin",
          mime: "application/octet-stream",
          url: "asset://not-readable-as-a-global-reference.bin",
        })
        await Session.updatePart({
          id: toolPartID,
          sessionID,
          messageID,
          type: "tool",
          tool: "fixture",
          callID: "private-tool-files",
          state: {
            status: "completed",
            input: {},
            output: "Created files",
            title: "Evidence",
            metadata: {},
            time: { start: 1, end: 2 },
            attachments: Array.from({ length: 65 }, (_, ordinal) => ({
              id: `prt_private_tool_file_${ordinal}`,
              sessionID,
              messageID,
              type: "attachment" as const,
              artifact,
              filename: `tool-${ordinal}.bin`,
              mime: "application/octet-stream",
              url: "https://unavailable.invalid/producer.bin",
            })),
          },
        })
        await Session.create({
          parentID: sessionID,
          workspaceID: null,
          cortex: {
            taskID: "task-private-read",
            parentSessionID: sessionID,
            parentMessageID: messageID,
            description: "A native private task",
            prompt: "Private delegation input",
            agent: "general",
            status: "completed",
            startedAt: 1,
            output: { mode: "summary", value: "Private delegation result" },
          },
        })
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
  const tasks = Read.Query.parse({ operation: "tasks", rootSessionID: sessionID, limit: 1 })
  const localTasks = Read.Result.parse(
    (await client.orgLocalSession.read({ orgPrivateReadQuery: tasks }, { throwOnError: true })).data,
  )
  const remoteTasks = Read.Result.parse(
    (
      await service.client.orgSessionRead.read(
        { sessionID, orgPrivateReadQuery: tasks },
        { headers: service.headers, throwOnError: true },
      )
    ).data,
  )
  expect(Read.matches(tasks, remoteTasks, localTasks.binding)).toBeTrue()
  expect(localTasks.operation === "tasks" && localTasks.items[0]?.taskID).toBe("task-private-read")
  expect(remoteTasks.operation === "tasks" && remoteTasks.items).toEqual(
    localTasks.operation === "tasks" && localTasks.items,
  )
  expect(JSON.stringify(remoteTasks)).not.toContain("Private delegation")
  const parts = Read.Result.parse(
    (
      await client.orgLocalSession.read(
        {
          orgPrivateReadQuery: {
            operation: "parts",
            rootSessionID: sessionID,
            messageID,
            limit: 64,
          },
        },
        { throwOnError: true },
      )
    ).data,
  )
  if (parts.operation !== "parts") throw new Error("Expected native message summaries")
  expect(parts.items.find((part) => part.partID === toolPartID)?.attachmentCount).toBe(65)
  const summary = parts.items.find((part) => part.partID === attachmentID)!
  const header = Read.Result.parse(
    (
      await client.orgLocalSession.read(
        {
          orgPrivateReadQuery: {
            operation: "partContent",
            rootSessionID: sessionID,
            messageID,
            partID: summary.partID,
            field: "text",
            offset: 0,
            length: 1,
          },
        },
        { throwOnError: true },
      )
    ).data,
  )
  if (header.operation !== "partContent" || header.state !== "ready")
    throw new Error("Expected native attachment header")
  const attachmentVersion = header.value.version
  expect(attachmentVersion).not.toBe(summary.content.version)
  expect(header.value.part).toMatchObject({ type: "attachment", filename: "private-file.bin" })
  const remoteHeader = Read.Result.parse(
    (
      await service.client.orgSessionRead.read(
        {
          sessionID,
          orgPrivateReadQuery: {
            operation: "partContent",
            rootSessionID: sessionID,
            messageID,
            partID: summary.partID,
            field: "text",
            offset: 0,
            length: 1,
          },
        },
        { headers: service.headers, throwOnError: true },
      )
    ).data,
  )
  expect(remoteHeader).toEqual(header)
  const toolQuery = Read.Query.parse({
    operation: "attachments",
    rootSessionID: sessionID,
    messageID,
    partID: toolPartID,
    limit: 32,
  })
  const localFiles = Read.Result.parse(
    (await client.orgLocalSession.read({ orgPrivateReadQuery: toolQuery }, { throwOnError: true })).data,
  )
  const remoteFiles = Read.Result.parse(
    (
      await service.client.orgSessionRead.read(
        { sessionID, orgPrivateReadQuery: toolQuery },
        { headers: service.headers, throwOnError: true },
      )
    ).data,
  )
  expect(Read.matches(toolQuery, remoteFiles, localFiles.binding)).toBe(true)
  expect(remoteFiles).toEqual(localFiles)
  if (localFiles.operation !== "attachments") throw new Error("Expected native tool file page")
  expect(localFiles.items).toHaveLength(32)
  expect(localFiles.total).toBe(65)
  expect(localFiles.cursor).toBeDefined()
  expect(JSON.stringify(remoteFiles)).not.toContain("unavailable.invalid")
  const nextFiles = Read.Result.parse(
    (
      await service.client.orgSessionRead.read(
        {
          sessionID,
          orgPrivateReadQuery: {
            operation: "attachments",
            rootSessionID: sessionID,
            messageID,
            partID: toolPartID,
            cursor: localFiles.cursor,
            limit: 32,
          },
        },
        { headers: service.headers, throwOnError: true },
      )
    ).data,
  )
  if (nextFiles.operation !== "attachments") throw new Error("Expected next native tool file page")
  expect(nextFiles.items[0].ordinal).toBe(32)
  for (const ordinal of [0, 64]) {
    const toolBytes = Read.Query.parse({
      operation: "attachmentContent",
      rootSessionID: sessionID,
      messageID,
      partID: toolPartID,
      version: localFiles.version,
      ordinal,
      offset: 1,
      length: 3,
    })
    const localBytes = Read.Result.parse(
      (await client.orgLocalSession.read({ orgPrivateReadQuery: toolBytes }, { throwOnError: true })).data,
    )
    const remoteBytes = Read.Result.parse(
      (
        await service.client.orgSessionRead.read(
          { sessionID, orgPrivateReadQuery: toolBytes },
          { headers: service.headers, throwOnError: true },
        )
      ).data,
    )
    expect(remoteBytes).toEqual(localBytes)
    expect(Read.matches(toolBytes, remoteBytes, localBytes.binding)).toBe(true)
    if (remoteBytes.operation !== "attachmentContent" || remoteBytes.state !== "ready")
      throw new Error("Expected native tool attachment bytes")
    expect(remoteBytes.ordinal).toBe(ordinal)
    expect(Buffer.from(remoteBytes.chunk.data, "base64url")).toEqual(Buffer.from(attachmentBytes.subarray(1, 4)))
  }
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
  const attachmentQuery = Read.Query.parse({
    operation: "attachmentContent",
    rootSessionID: sessionID,
    messageID,
    partID: attachmentID,
    version: attachmentVersion,
    offset: 0,
    length: 65_536,
  })
  const localAttachment = Read.Result.parse(
    (await client.orgLocalSession.read({ orgPrivateReadQuery: attachmentQuery }, { throwOnError: true })).data,
  )
  const remoteAttachment = Read.Result.parse(
    (
      await service.client.orgSessionRead.read(
        { sessionID, orgPrivateReadQuery: attachmentQuery },
        { headers: service.headers, throwOnError: true },
      )
    ).data,
  )
  expect(Read.matches(attachmentQuery, remoteAttachment, local.binding)).toBeTrue()
  expect(remoteAttachment).toEqual(localAttachment)
  if (remoteAttachment.operation !== "attachmentContent" || remoteAttachment.state !== "ready")
    throw new Error("Expected retained private attachment")
  expect(Buffer.from(remoteAttachment.chunk.data, "base64url")).toEqual(
    Buffer.from(attachmentBytes.subarray(0, 65_536)),
  )
  expect(remoteAttachment.reference.filename).toBe("private-file.bin")
  expect(JSON.stringify(remoteAttachment)).not.toContain("asset:")
  const attachmentTail = Read.Query.parse({ ...attachmentQuery, offset: 65_536 })
  const tail = Read.Result.parse(
    (
      await service.client.orgSessionRead.read(
        { sessionID, orgPrivateReadQuery: attachmentTail },
        { headers: service.headers, throwOnError: true },
      )
    ).data,
  )
  expect(Read.matches(attachmentTail, tail, local.binding)).toBeTrue()
  if (tail.operation !== "attachmentContent" || tail.state !== "ready")
    throw new Error("Expected final private attachment range")
  expect(Buffer.from(tail.chunk.data, "base64url")).toEqual(Buffer.from(attachmentBytes.subarray(65_536)))
  expect(tail.chunk.complete).toBe(true)
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
