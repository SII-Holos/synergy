import { expect, test } from "bun:test"
import {
  OrganizationReadProtocol as Read,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionHistory } from "@ericsanchezok/synergy-harness/session/history"
import { RolloutArtifact } from "@ericsanchezok/synergy-harness/session/rollout/artifact"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { registerSessionSchema } from "../src/session-schema"
import { createSessionReader } from "../src/session-read"
import { readNativeAttachment, readNativeContent } from "../src/read-content"

const binding = {
  schemaVersion: 1,
  orgID: "attachment-org",
  projectID: "attachment-project",
  creatorID: "attachment-account",
  driverRuntimeID: "attachment-runtime",
  bindingEpoch: 1,
} as const
const identity = { orgID: binding.orgID, accountID: binding.creatorID, deviceID: "attachment-device" }

test("local and signed attachment reads share canonical byte ownership, creator checks and exact version conflicts", async () => {
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
        const owner = { kind: "session" as const, scopeID: scope.id, sessionID: session.id }
        const bytes = Uint8Array.from([0, 255, 128, 254, 1])
        const artifact = await RolloutArtifact.write(
          owner,
          (async function* () {
            yield bytes
          })(),
          "application/octet-stream",
        )
        const part = {
          id: partID,
          messageID,
          sessionID: session.id,
          type: "attachment" as const,
          artifact,
          mime: "application/octet-stream",
          filename: "retained.bin",
          url: "asset://not-read-from-global-store.bin",
        }
        await Session.updatePart(part)
        const { version } = await SessionHistory.partFieldDescriptor({ sessionID: session.id, messageID, partID })
        const query = Read.Query.parse({
          operation: "attachmentContent",
          rootSessionID: session.id,
          messageID,
          partID,
          version,
          offset: 1,
          length: 3,
        })
        if (query.operation !== "attachmentContent") throw new Error("Expected an attachment query")
        let reads = 0
        const options = {
          identity,
          runtimeID: binding.driverRuntimeID,
          content: readNativeContent,
          attachment: async (...args: Parameters<typeof readNativeAttachment>) => {
            reads++
            return readNativeAttachment(...args)
          },
        }
        const reader = createSessionReader(options)
        const local = await reader.local(query)
        expect(Read.matches(query, local, binding)).toBe(true)
        if (local.operation !== "attachmentContent" || local.state !== "ready")
          throw new Error("Expected attachment bytes")
        expect(Buffer.from(local.chunk.data, "base64url")).toEqual(Buffer.from(bytes.subarray(1, 4)))
        expect(JSON.stringify(local)).not.toContain("asset:")
        const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
        const connection = Runtime.Connected.parse({
          type: "handshake",
          protocolVersion: 1,
          orgID: binding.orgID,
          deploymentIncarnation: "attachment-deployment",
          runtimeID: binding.driverRuntimeID,
          connectionEpoch: 2,
          signingIdentity: {
            schemaVersion: 1,
            orgID: binding.orgID,
            deploymentIncarnation: "attachment-deployment",
            keyID: "attachment-key",
            publicKey: await Read.publicKey(keys.publicKey),
          },
          heartbeatMs: 100,
          offlineMs: 300,
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
          keyID: "attachment-key",
          bindingEpoch: 1,
          connectionEpoch: 2,
          query,
          issuedAt: Date.now(),
          expiresAt: Date.now() + 10_000,
        })
        const signature = await Read.sign(permit, keys.privateKey)
        expect(await reader.remote({ permit, signature }, connection)).toEqual(local)
        const before = reads
        await expect(
          reader.remote({ permit: { ...permit, query: { ...query, partID: "another-part" } }, signature }, connection),
        ).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
        await expect(
          createSessionReader({ ...options, identity: { ...identity, accountID: "another-account" } }).local(query),
        ).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
        expect(reads).toBe(before)
        const unrelated = await Session.create({ organization: binding, workspaceID: null })
        await expect(reader.local({ ...query, sourceSessionID: unrelated.id })).rejects.toThrow()
        expect(reads).toBe(before)
        await Session.updatePart({ ...part, filename: "changed.bin" })
        await expect(reader.local(query)).rejects.toMatchObject({ data: { code: "REVISION_CONFLICT" } })
      },
    })
  })
}, 15_000)
