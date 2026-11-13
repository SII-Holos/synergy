import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import { z } from "zod"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutArtifact } from "@ericsanchezok/synergy-harness/session/rollout/artifact"
import { OrganizationRuntimeProtocol as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import { prepareMemberHome } from "../src/home"
import { enrollMemberRuntime } from "../src/enrollment"
import { openMemberRuntime } from "../src/runtime"
import { fixture } from "./support/organization"
import { applySelection, publish } from "./support/knowledge"
import { ModelRequest, SkillEvidence, runtimeContext, modelResponse, waitKnowledgeTask } from "./support/knowledge-task"

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
async function bounded<T>(work: Promise<T>) {
  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(() => timeout.reject(new Error("The actual knowledge update boundary did not settle")), 4000)
  try {
    return await Promise.race([work, timeout.promise])
  } finally {
    clearTimeout(timer)
  }
}

test("an actual Member task applies knowledge at the next model boundary without interrupting its connection tool", async () => {
  await using service = await fixture()
  const options = { headers: service.headers, throwOnError: true as const }
  const calls: Array<z.infer<typeof ModelRequest>> = []
  const connectionCalls: Array<{ authorization: string | null; body: unknown }> = []
  const connectionStarted = Promise.withResolvers<void>()
  const connectionReleased = Promise.withResolvers<void>()
  let connectionCancelled = false
  let connectionResourceID: string | undefined
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/business") {
        connectionCalls.push({ authorization: request.headers.get("authorization"), body: await request.json() })
        const aborted = () => {
          connectionCancelled = true
        }
        request.signal.addEventListener("abort", aborted, { once: true })
        connectionStarted.resolve()
        await connectionReleased.promise
        if (request.signal.aborted) connectionCancelled = true
        request.signal.removeEventListener("abort", aborted)
        return Response.json({ operation: "original-business-work", complete: true })
      }
      const input = ModelRequest.parse(await request.json())
      calls.push(input)
      if (!runtimeContext(input)) return modelResponse(calls.length)
      const step = calls.filter((call) => runtimeContext(call) !== undefined).length
      if (step === 1 || step === 3) return modelResponse(calls.length, { name: "skill", input: { name: "team-work" } })
      if (step === 2) {
        if (!connectionResourceID) throw new Error("The actual connection has not been configured")
        return modelResponse(calls.length, {
          name: "organization_connection",
          input: { resourceID: connectionResourceID, body: { operation: "original-business-work" } },
        })
      }
      return modelResponse(calls.length)
    },
  })
  try {
    const member = await prepareMemberHome({
      baseDirectory: path.join(service.root, "members"),
      identity: service.identity,
      origin: service.origin,
    })
    const registration = await enrollMemberRuntime({
      home: member.home,
      identity: member.identity,
      ca: service.ca,
      ticket: await service.ticket(member.identity.deviceID, member.publicKey),
    })
    const project = (
      await service.client.orgProjects.create(
        { orgProjectCreate: { name: "Knowledge boundary", description: "" } },
        options,
      )
    ).data
    const first = await publish(
      service,
      project.projectID,
      "---\nname: team-work\ndescription: Team work\n---\nOriginal selected instructions",
      0,
    )
    await applySelection(service, {
      projectID: project.projectID,
      expectedRevision: 0,
      releases: [first.reference],
    })
    const second = await publish(
      service,
      project.projectID,
      "---\nname: team-work\ndescription: Team work\n---\nExplicitly updated instructions",
      1,
    )
    const model = (
      await service.client.orgResources.create(
        {
          orgResourceCreate: {
            name: "Knowledge model",
            scope: { kind: "organization" },
            configuration: {
              protocol: "openai-compatible",
              endpoint: new URL("/v1", upstream.url).href,
              model: { id: "knowledge-model", name: "Knowledge", limit: { context: 128000, output: 4096 } },
            },
            credential: { kind: "bearer", value: "service-model-key" },
          },
        },
        options,
      )
    ).data
    const connection = (
      await service.client.orgResources.create(
        {
          orgResourceCreate: {
            name: "Held connection",
            scope: { kind: "organization" },
            configuration: {
              protocol: "fixed-http",
              method: "POST",
              endpoint: new URL("/business", upstream.url).href,
            },
            credential: { kind: "bearer", value: "service-connection-key" },
          },
        },
        options,
      )
    ).data
    connectionResourceID = connection.resourceID
    for (const resource of [model, connection])
      await service.client.orgResourceGrants.set(
        {
          resourceID: resource.resourceID,
          kind: "account",
          subjectID: service.identity.accountID,
          orgResourceGrantChange: { expectedRevision: 0, enabled: true },
        },
        options,
      )
    const online = Promise.withResolvers<void>()
    service.interceptFrames((_socket, raw) => {
      if (Protocol.ClientFrame.parse(JSON.parse(String(raw))).type === "heartbeat") online.resolve()
      return false
    })
    const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
    const port = portProbe.port
    if (!port) throw new Error("The isolated Member listener did not reserve a port")
    await portProbe.stop(true)
    const runtime = await openMemberRuntime({
      home: member.home,
      identity: member.identity,
      ca: service.ca,
      listen: { port, token: "e".repeat(64) },
    })
    try {
      await bounded(online.promise)
      service.interceptFrames(undefined)
      const target = {
        schemaVersion: 1 as const,
        orgID: member.identity.orgID,
        projectID: project.projectID,
        runtimeID: registration.runtimeID,
      }
      const created = (
        await service.client.orgSessions.create(
          {
            orgCommandCreateRequest: {
              ...target,
              requestID: "knowledge-boundary-create",
              creation: { operation: "create", title: "Knowledge update while a tool runs" },
            },
          },
          options,
        )
      ).data
      const sessionID = created.effect.sessionID
      await service.client.orgSessionResources.set(
        {
          sessionID,
          orgSessionResourceChange: {
            expectedRevision: 0,
            selection: {
              modelResourceID: model.resourceID,
              connectionResourceIDs: [connection.resourceID],
              infrastructure: { workspace: null, environment: null },
            },
          },
        },
        options,
      )
      const accepted = (
        await service.client.orgCommands.input(
          {
            sessionID,
            orgCommandInputRequest: {
              ...target,
              sessionID,
              requestID: "knowledge-boundary-input",
              input: {
                operation: "input",
                mode: "task",
                parts: [
                  {
                    type: "text",
                    text: "Load the Skill, complete the selected connection, then load the Skill again.",
                  },
                ],
              },
            },
          },
          options,
        )
      ).data
      await bounded(connectionStarted.promise)
      expect(calls.filter((call) => runtimeContext(call) !== undefined)).toHaveLength(2)
      expect(connectionCalls).toEqual([
        { authorization: "Bearer service-connection-key", body: { operation: "original-business-work" } },
      ])
      expect(connectionCancelled).toBe(false)
      const before = await runtime.run(() => MessageV2.get({ sessionID, messageID: accepted.effect.messageID }))
      await applySelection(service, {
        projectID: project.projectID,
        expectedRevision: 1,
        releases: [second.reference],
      })
      expect(calls.filter((call) => runtimeContext(call) !== undefined)).toHaveLength(2)
      expect(connectionCancelled).toBe(false)
      expect((await service.client.orgKnowledge.status({ sessionID }, options)).data).toMatchObject({
        state: "pending",
        desired: { manifestHash: hash(JSON.stringify([second.reference])) },
        activated: { manifestHash: hash(JSON.stringify([first.reference])) },
      })
      connectionReleased.resolve()
      const { owner, rootID } = await waitKnowledgeTask(runtime, accepted, () => calls.length)
      expect(connectionCalls).toHaveLength(1)
      expect(connectionCancelled).toBe(false)
      const conversationRequests = calls.filter((call) => runtimeContext(call) !== undefined)
      expect(conversationRequests).toHaveLength(4)
      const firstCall = conversationRequests[0],
        nextCall = conversationRequests[2]
      if (!firstCall || !nextCall) throw new Error("The real model boundary was not recorded")
      expect(runtimeContext(firstCall)).toContain(`itemID=team version=1 manifestHash=${first.reference.manifestHash}`)
      expect(runtimeContext(firstCall)).not.toContain(second.reference.manifestHash)
      expect(runtimeContext(nextCall)).toContain(`itemID=team version=2 manifestHash=${second.reference.manifestHash}`)
      expect(runtimeContext(nextCall)).not.toContain(
        `itemID=team version=1 manifestHash=${first.reference.manifestHash}`,
      )
      const after = await runtime.run(() => MessageV2.get({ sessionID, messageID: rootID }))
      if (before.info.role !== "user" || after.info.role !== "user")
        throw new Error("The original input is not a native user record")
      expect(after.parts).toEqual(before.parts)
      expect(after.info).toMatchObject({
        id: before.info.id,
        rootID: before.info.rootID,
        actor: before.info.actor,
        metadata: before.info.metadata,
      })
      await runtime.run(async () => {
        const recorded = (await RolloutLedger.calls(owner, rootID)).sort((a, b) => a.started - b.started)
        expect(recorded).toHaveLength(calls.length)
        expect(recorded.every((call) => call.status === "completed" && call.transportCaptured)).toBe(true)
        const conversation = recorded.filter((call) => call.usageRole === "conversation")
        const auxiliary = recorded.filter((call) => call.usageRole !== "conversation")
        expect(conversation).toHaveLength(conversationRequests.length)
        expect(conversation.every((call) => call.purpose === PrimaryAgentIdentity.names.general)).toBe(true)
        expect(auxiliary).toMatchObject([
          { purpose: "title", usageRole: "auxiliary", agent: "title", status: "completed" },
        ])
        const text = async (id: string) => {
          const chunks: Uint8Array[] = []
          for await (const chunk of RolloutArtifact.read(owner, id)) chunks.push(chunk)
          return Buffer.concat(chunks).toString()
        }
        const originalRequest = conversation[0],
          updatedRequest = conversation[2]
        if (!originalRequest || !updatedRequest) throw new Error("The original model records are missing")
        expect(await text(originalRequest.request.id)).toContain(first.reference.manifestHash)
        expect(await text(updatedRequest.request.id)).toContain(second.reference.manifestHash)
        const tools = await RolloutLedger.tools(owner, rootID)
        expect(tools).toHaveLength(3)
        expect(tools.every((tool) => tool.status === "completed")).toBe(true)
        const connectionTool = tools.filter((tool) => tool.tool === "organization_connection")
        expect(connectionTool).toHaveLength(1)
        const skills = tools.filter((tool) => tool.tool === "skill").sort((a, b) => a.started - b.started)
        expect(skills).toHaveLength(2)
        for (const [index, expected] of [first.reference, second.reference].entries()) {
          const tool = skills[index]
          if (!tool?.rawResult) throw new Error("The actual Skill load did not retain its raw provenance")
          const evidence = SkillEvidence.parse(JSON.parse(await text(tool.rawResult.id)))
          expect(evidence.provenance).toEqual(expected)
          expect(evidence.sha256).toBe(hash(evidence.content))
          expect(evidence.content.trim()).toBe(
            index === 0 ? "Original selected instructions" : "Explicitly updated instructions",
          )
        }
      })
      expect((await service.client.orgKnowledge.status({ sessionID }, options)).data).toMatchObject({
        state: "active",
        activated: { manifestHash: hash(JSON.stringify([second.reference])) },
      })
    } finally {
      connectionReleased.resolve()
      await runtime.close()
    }
  } finally {
    connectionReleased.resolve()
    await upstream.stop(true)
  }
})
