import { expect, test } from "bun:test"
import {
  OrganizationReadProtocol as Read,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { registerSessionSchema } from "../src/session-schema"
import { createSessionReader } from "../src/session-read"
import { readNativeContent } from "../src/read-content"
import { SessionHistory } from "@ericsanchezok/synergy-harness/session/history"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"

const binding = {
  schemaVersion: 1,
  orgID: "read-org",
  projectID: "read-project",
  creatorID: "read-creator",
  driverRuntimeID: "read-runtime",
  bindingEpoch: 1,
} as const
const identity = { orgID: binding.orgID, accountID: binding.creatorID, deviceID: "read-device" }

test("private task reading pages only native visible children through the same creator and source authority", async () => {
  await using runtime = await testRuntime({ register: () => registerSessionSchema(binding) })
  await runtime.run(async () => {
    const scope = await Scope.registerProject({
      type: "project",
      id: binding.projectID,
      local: null,
      time: { created: 1, updated: 1 },
    })
    await ScopeContext.provide({
      scope,
      workspace: null,
      fn: async () => {
        const root = await Session.create({ organization: binding, workspaceID: null })
        const other = await Session.create({ organization: binding, workspaceID: null })
        const expected: string[] = []
        for (let index = 0; index < 4; index++) {
          const child = await Session.create({
            parentID: root.id,
            workspaceID: null,
            cortex: {
              taskID: Identifier.short("cortex"),
              parentSessionID: root.id,
              parentMessageID: Identifier.ascending("message"),
              description: `Visible task ${index}`,
              prompt: "Never expose the private task prompt",
              agent: "general",
              status: "completed",
              startedAt: index + 1,
              visibility: index === 3 ? "hidden" : "visible",
              output: { mode: "summary", value: "Never expose the private task result" },
            },
          })
          if (index !== 3) expected.push(child.id)
        }
        const reader = createSessionReader({
          identity,
          runtimeID: binding.driverRuntimeID,
          content: async () => {
            throw new Error("Task metadata cannot read message contents")
          },
        })
        const first = await reader.local({ operation: "tasks", rootSessionID: root.id, limit: 2 })
        if (first.operation !== "tasks") throw new Error("Expected a task page")
        expect(first.total).toBe(3)
        expect(first.items).toHaveLength(2)
        expect(JSON.stringify(first)).not.toContain("Never expose")
        const last = await reader.local({ operation: "tasks", rootSessionID: root.id, limit: 2, cursor: first.cursor })
        if (last.operation !== "tasks") throw new Error("Expected a task page")
        expect([...first.items, ...last.items].map((item) => item.sessionID)).toEqual(expected.sort())
        expect(last.cursor).toBeUndefined()
        await expect(
          reader.local({ operation: "tasks", rootSessionID: other.id, cursor: first.cursor }),
        ).rejects.toThrow()
        const stranger = createSessionReader({
          identity: { ...identity, accountID: "another-account" },
          runtimeID: binding.driverRuntimeID,
          content: readNativeContent,
        })
        await expect(stranger.local({ operation: "tasks", rootSessionID: root.id })).rejects.toMatchObject({
          data: { code: "PERMISSION_DENIED" },
        })
      },
    })
  })
}, 15_000)

test("private reader uses native bounded history and rejects another creator or unrelated source", async () => {
  await using runtime = await testRuntime({ register: () => registerSessionSchema(binding) })
  await runtime.run(async () => {
    const scope = await Scope.registerProject({
      type: "project",
      id: binding.projectID,
      local: null,
      time: { created: 1, updated: 1 },
    })
    return ScopeContext.provide({
      scope,
      workspace: null,
      fn: async () => {
        const create = () =>
          ScopeContext.provide({
            scope,
            workspace: null,
            fn: () => Session.create({ organization: binding, workspaceID: null }),
          })
        const root = await create()
        const other = await create()
        await Session.updateMessage({
          id: "msg_read_one",
          sessionID: root.id,
          role: "user",
          time: { created: 1 },
          agent: "general",
          model: { providerID: "fixture", modelID: "fixture-model" },
        })
        await Session.updatePart({
          id: "prt_read_one",
          sessionID: root.id,
          messageID: "msg_read_one",
          type: "text",
          text: "Native private conversation",
        })
        await Session.flushPartWrites(root.id)
        let contentCalls = 0
        const content = async (): Promise<never> => {
          contentCalls++
          throw new Error("Content must not be read without its authorized operation")
        }
        const reader = createSessionReader({ identity, runtimeID: binding.driverRuntimeID, content })
        const page = await reader.local({ operation: "timeline", rootSessionID: root.id, limit: 1 })
        expect(page.operation).toBe("timeline")
        if (page.operation !== "timeline") throw new Error("Expected a timeline page")
        expect(page.items.map((item) => item.messageID)).toEqual(["msg_read_one"])
        expect(page.items[0]!.model).toEqual({ providerID: "fixture", modelID: "fixture-model" })
        expect(JSON.stringify(page)).not.toContain('"path"')
        const parts = await reader.local({ operation: "parts", rootSessionID: root.id, messageID: "msg_read_one" })
        expect(parts.operation === "parts" && parts.items[0]?.partID).toBe("prt_read_one")
        await expect(
          reader.local({ operation: "session", rootSessionID: root.id, sourceSessionID: other.id }),
        ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } })
        const denied = createSessionReader({
          identity: { ...identity, accountID: "other-account" },
          runtimeID: binding.driverRuntimeID,
          content,
        })
        await expect(denied.local({ operation: "session", rootSessionID: root.id })).rejects.toMatchObject({
          data: { code: "PERMISSION_DENIED" },
        })
        expect(contentCalls).toBe(0)
        await SessionManager.run(
          root.id,
          async (lease) => {
            SessionManager.bindRootTask(lease, "msg_read_one")
            const status = await reader.local({ operation: "status", rootSessionID: root.id })
            expect(status.operation === "status" && status.status.runID).toBe("msg_read_one")
            expect(status.operation === "status" && status.status.controlVersion).toBe(0)
          },
          { workspace: "history" },
        )
        expect((await MessageV2.get({ sessionID: root.id, messageID: "msg_read_one" })).parts[0]?.type).toBe("text")
      },
    })
  })
}, 15_000)

test("remote private reads verify creator, full signed target and current connection before native access", async () => {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const publicKey = await Read.publicKey(keys.publicKey)
  const connection = Runtime.Connected.parse({
    type: "handshake",
    protocolVersion: 1,
    orgID: binding.orgID,
    deploymentIncarnation: "read-deployment",
    runtimeID: binding.driverRuntimeID,
    connectionEpoch: 2,
    signingIdentity: {
      schemaVersion: 1,
      orgID: binding.orgID,
      deploymentIncarnation: "read-deployment",
      keyID: "read-key",
      publicKey,
    },
    heartbeatMs: 100,
    offlineMs: 300,
  })
  const reader = createSessionReader({
    identity,
    runtimeID: binding.driverRuntimeID,
    content: async () => {
      throw new Error("Denied target cannot read native content")
    },
  })
  const permit = Read.Permit.parse({
    purpose: "session-read",
    schemaVersion: 1,
    orgID: binding.orgID,
    deploymentIncarnation: connection.deploymentIncarnation,
    runtimeID: binding.driverRuntimeID,
    projectID: binding.projectID,
    creatorID: binding.creatorID,
    subjectID: binding.creatorID,
    keyID: "read-key",
    bindingEpoch: 1,
    connectionEpoch: 2,
    query: { operation: "session", rootSessionID: "session-unavailable" },
    issuedAt: Date.now(),
    expiresAt: Date.now() + 10_000,
  })
  const signature = await Read.sign(permit, keys.privateKey)
  for (const changed of [
    { ...permit, subjectID: "other-reader" },
    { ...permit, connectionEpoch: 3 },
    { ...permit, query: { ...permit.query, rootSessionID: "other-session" } },
  ])
    await expect(reader.remote({ permit: changed, signature }, connection)).rejects.toMatchObject({
      data: { code: "PERMISSION_DENIED" },
    })
  const aborted = new AbortController()
  aborted.abort()
  await expect(reader.remote({ permit, signature }, connection, aborted.signal)).rejects.toThrow()
})

test("native read content exposes exact field references and bounded byte slices", async () => {
  await using runtime = await testRuntime({ register: () => registerSessionSchema(binding) })
  await runtime.run(async () => {
    const scope = await Scope.registerProject({
      type: "project",
      id: binding.projectID,
      local: null,
      time: { created: 1, updated: 1 },
    })
    return ScopeContext.provide({
      scope,
      workspace: null,
      fn: async () => {
        const session = await Session.create({ organization: binding, workspaceID: null })
        const messageID = "msg_native_content"
        const partID = "prt_native_content"
        await Session.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          isRoot: true,
          rootID: messageID,
          agent: "general",
          model: { providerID: "fixture", modelID: "fixture" },
          time: { created: 1 },
        })
        const text = "完整原文🌏".repeat(20_000)
        await Session.updatePart({ id: partID, messageID, sessionID: session.id, type: "text", text })
        await Session.flushPartWrites(session.id)
        const reader = createSessionReader({ identity, runtimeID: binding.driverRuntimeID, content: readNativeContent })
        const query = Read.Query.parse({
          operation: "partContent",
          rootSessionID: session.id,
          messageID,
          partID,
          field: "text",
          offset: 1025,
          length: 4096,
        })
        let result = await reader.local(query)
        expect(Read.matches(query, result)).toBeTrue()
        if (result.operation === "partContent" && result.state === "preparing") {
          await SessionHistory.partFieldDescriptor({ sessionID: session.id, messageID, partID })
          result = await reader.local(query)
        }
        if (result.operation !== "partContent" || result.state !== "ready") throw new Error("Expected native content")
        expect(result.value.part.type).toBe("text")
        expect(result.chunk?.original).toBe("complete")
        expect(Buffer.from(result.chunk!.data, "base64url")).toEqual(Buffer.from(text).subarray(1025, 1025 + 4096))
        expect(JSON.stringify(result)).not.toContain("完整原文")
        expect(JSON.stringify(result)).not.toContain('"scope"')
      },
    })
  })
}, 15_000)
