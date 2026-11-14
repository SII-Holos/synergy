import { expect, test } from "bun:test"
import {
  OrganizationReadProtocol as Read,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { RolloutArtifact } from "@ericsanchezok/synergy-harness/session/rollout/artifact"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { registerSessionSchema } from "../src/session-schema"
import { createSessionReader } from "../src/session-read"
import { readNativeAttachment, readNativeContent } from "../src/read-content"

test("creator and signed tool attachment reads page canonical metadata and bind binary bytes to one native ordinal", async () => {
  const binding = {
    schemaVersion: 1,
    orgID: "tool-org",
    projectID: "tool-project",
    creatorID: "tool-creator",
    driverRuntimeID: "tool-runtime",
    bindingEpoch: 1,
  } as const
  const identity = { orgID: binding.orgID, accountID: binding.creatorID, deviceID: "device" }
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
        const session = await Session.create({ organization: binding, workspaceID: null })
        const messageID = Identifier.ascending("message")
        const partID = Identifier.ascending("part")
        await Session.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          rootID: messageID,
          agent: "general",
          model: { providerID: "fixture", modelID: "fixture" },
          time: { created: 1 },
        })
        const bytes = new Uint8Array([0, 255, 128, 254, 1])
        const artifact = await RolloutArtifact.write(
          { kind: "session", scopeID: scope.id, sessionID: session.id },
          (async function* () {
            yield bytes
          })(),
          "application/octet-stream",
        )
        const attachments = Array.from({ length: 65 }, (_, ordinal) => ({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID,
          type: "attachment" as const,
          url: "https://unavailable.invalid/evidence.bin",
          filename: `evidence-${ordinal}.bin`,
          mime: "application/octet-stream",
          artifact,
        }))
        const part = {
          id: partID,
          sessionID: session.id,
          messageID,
          type: "tool" as const,
          tool: "fixture",
          callID: "tool-call",
          state: {
            status: "completed" as const,
            input: {},
            output: "Completed",
            title: "Evidence",
            metadata: {},
            time: { start: 1, end: 2 },
            attachments,
          },
        }
        await Session.updatePart(part)
        const options = {
          identity,
          runtimeID: binding.driverRuntimeID,
          content: readNativeContent,
          attachment: readNativeAttachment,
        }
        const reader = createSessionReader(options)
        const summaries = await reader.local({ operation: "parts", rootSessionID: session.id, messageID, limit: 64 })
        if (summaries.operation !== "parts") throw new Error("Expected native part summaries")
        expect(summaries.items.find((item) => item.partID === partID)?.attachmentCount).toBe(65)
        const query = Read.Query.parse({
          operation: "attachments",
          rootSessionID: session.id,
          messageID,
          partID,
          limit: 32,
        })
        if (query.operation !== "attachments") throw new Error("Expected attachment metadata query")
        const first = await reader.local(query)
        expect(Read.matches(query, first, binding)).toBe(true)
        if (first.operation !== "attachments") throw new Error("Expected native tool files")
        expect(first.total).toBe(65)
        expect(first.items).toHaveLength(32)
        expect(JSON.stringify(first)).not.toMatch(/unavailable.invalid|artifact|url/)
        const second = await reader.local({ ...query, cursor: first.cursor })
        if (second.operation !== "attachments") throw new Error("Expected next tool files")
        expect(second.items[0].ordinal).toBe(32)
        const third = await reader.local({ ...query, cursor: second.cursor })
        if (third.operation !== "attachments") throw new Error("Expected final tool file")
        expect(third.items).toHaveLength(1)
        expect(third.items[0].ordinal).toBe(64)
        const contentQuery = Read.Query.parse({
          operation: "attachmentContent",
          rootSessionID: session.id,
          messageID,
          partID,
          version: third.version,
          ordinal: 64,
          offset: 1,
          length: 3,
        })
        if (contentQuery.operation !== "attachmentContent") throw new Error("Expected attachment byte query")
        const local = await reader.local(contentQuery)
        expect(Read.matches(contentQuery, local, binding)).toBe(true)
        if (local.operation !== "attachmentContent" || local.state !== "ready")
          throw new Error("Expected tool binary bytes")
        expect(Buffer.from(local.chunk.data, "base64url")).toEqual(Buffer.from(bytes.subarray(1, 4)))
        const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
        const publicKey = await Read.publicKey(keys.publicKey)
        const connection = Runtime.Connected.parse({
          type: "handshake",
          protocolVersion: 1,
          orgID: binding.orgID,
          deploymentIncarnation: "deployment",
          runtimeID: binding.driverRuntimeID,
          connectionEpoch: 2,
          signingIdentity: {
            schemaVersion: 1,
            orgID: binding.orgID,
            deploymentIncarnation: "deployment",
            keyID: "key",
            publicKey,
          },
          heartbeatMs: 100,
          offlineMs: 300,
        })
        const permit = Read.Permit.parse({
          purpose: "session-read",
          schemaVersion: 1,
          orgID: binding.orgID,
          deploymentIncarnation: "deployment",
          runtimeID: binding.driverRuntimeID,
          projectID: binding.projectID,
          creatorID: binding.creatorID,
          subjectID: binding.creatorID,
          keyID: "key",
          bindingEpoch: 1,
          connectionEpoch: 2,
          query: contentQuery,
          issuedAt: Date.now(),
          expiresAt: Date.now() + 10000,
        })
        const signature = await Read.sign(permit, keys.privateKey)
        expect(await reader.remote({ permit, signature }, connection)).toEqual(local)
        await expect(
          reader.remote({ permit: { ...permit, query: { ...contentQuery, ordinal: 63 } }, signature }, connection),
        ).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
        await expect(
          createSessionReader({ ...options, identity: { ...identity, accountID: "foreign" } }).local(query),
        ).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
        await Session.updatePart({ ...part, state: { ...part.state, attachments: attachments.toReversed() } })
        await expect(reader.local(contentQuery)).rejects.toMatchObject({ data: { code: "REVISION_CONFLICT" } })
      },
    })
  })
}, 15000)
