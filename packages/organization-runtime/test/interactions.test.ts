import { expect, test } from "bun:test"
import {
  OrganizationInteractionProtocol as Protocol,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerSessionSchema } from "../src/session-schema"
import { createInteractionReader } from "../src/interactions"

const binding = {
  schemaVersion: 1 as const,
  orgID: "org-interactions",
  projectID: "project-interactions",
  creatorID: "A",
  driverRuntimeID: "runtime-interactions",
  bindingEpoch: 1,
}
const identity = { orgID: binding.orgID, accountID: "A", deviceID: "fixture-device" }
async function authority() {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const connection = Runtime.Connected.parse({
    type: "handshake",
    protocolVersion: 1,
    orgID: binding.orgID,
    deploymentIncarnation: "fixture-deployment",
    runtimeID: binding.driverRuntimeID,
    connectionEpoch: 1,
    signingIdentity: {
      schemaVersion: 1,
      orgID: binding.orgID,
      deploymentIncarnation: "fixture-deployment",
      keyID: "fixture-key",
      publicKey: await Runtime.publicKey(keys.publicKey),
    },
    heartbeatMs: 100,
    offlineMs: 300,
  })
  return {
    connection,
    async sign(query: Protocol.Query) {
      const permit = Protocol.Permit.parse({
        schemaVersion: 1,
        purpose: "session-interactions",
        orgID: binding.orgID,
        deploymentIncarnation: connection.deploymentIncarnation,
        keyID: "fixture-key",
        runtimeID: binding.driverRuntimeID,
        connectionEpoch: 1,
        subjectID: "B",
        binding,
        query,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 10_000,
      })
      return { permit, signature: await Protocol.sign(permit, keys.privateKey) }
    },
  }
}

test("signed safe interaction windows preserve native identities without metadata and expose a committed winner", async () => {
  const service = await authority()
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
        const reader = createInteractionReader({ identity, runtimeID: binding.driverRuntimeID })
        const controller = new AbortController()
        const pending: Promise<unknown>[] = []
        try {
          for (let index = 0; index < 2; index++) {
            const id = `permission-safe-${index}`
            const asked = Promise.withResolvers<void>()
            const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, ({ properties }) => {
              if (properties.id === id) asked.resolve()
            })
            pending.push(
              PermissionNext.ask({
                id,
                sessionID: root.id,
                permission: "bash",
                patterns: ["fixture *"],
                metadata: { secret: "must-not-leave-native-metadata", localPath: "/private/native-source" },
                ruleset: [],
                signal: controller.signal,
              }).catch((error: unknown) => error),
            )
            try {
              await asked.promise
            } finally {
              unsubscribe()
            }
          }
          const query = Protocol.Query.parse({ operation: "pending", rootSessionID: root.id, limit: 1 })
          if (query.operation !== "pending") throw new Error("Expected pending query")
          const first = await reader.remote(await service.sign(query), service.connection)
          expect(Protocol.matches(query, first, binding)).toBeTrue()
          expect(first.operation === "pending" && first.items).toHaveLength(1)
          expect(JSON.stringify(first)).not.toContain("must-not-leave-native-metadata")
          expect(JSON.stringify(first)).not.toContain("/private/native-source")
          if (first.operation !== "pending") throw new Error("Expected pending window")
          expect(first.items[0]).toMatchObject({ requestID: "permission-safe-0", alwaysScope: "runtime" })
          await PermissionNext.decide({
            sessionID: root.id,
            requestID: "permission-safe-0",
            reply: "once",
            actor: {
              kind: "account",
              orgID: binding.orgID,
              subjectID: "B",
              displayName: "B",
              requestID: "accepted-command",
              clientKind: "web",
            },
          })
          const second = await reader.remote(await service.sign({ ...query, cursor: first.cursor }), service.connection)
          expect(second.operation === "pending" && second.items[0]?.requestID).toBe("permission-safe-1")
          const decisions = await reader.remote(
            await service.sign({
              operation: "decisions",
              rootSessionID: root.id,
              identities: [
                { kind: "permission", requestID: "permission-safe-0" },
                { kind: "permission", requestID: "permission-safe-1" },
                { kind: "question", requestID: "question-expired" },
              ],
            }),
            service.connection,
          )
          expect(decisions.operation === "decisions" && decisions.items.map((entry) => entry.state)).toEqual([
            "resolved",
            "pending",
            "expired",
          ])
          expect(decisions.operation === "decisions" && decisions.items[0]).toMatchObject({
            winner: { actor: { subjectID: "B" }, outcome: { reply: "once" } },
          })
        } finally {
          controller.abort()
          await Promise.allSettled(pending)
        }
      },
    })
  })
})

test("native interaction reads reject altered signed subjects, bindings and connections before looking up a source", async () => {
  const service = await authority()
  const reader = createInteractionReader({ identity, runtimeID: binding.driverRuntimeID })
  const signed = await service.sign({ operation: "pending", rootSessionID: "session-unavailable", limit: 1 })
  for (const permit of [
    { ...signed.permit, subjectID: "C" },
    { ...signed.permit, connectionEpoch: 2 },
    { ...signed.permit, binding: { ...binding, bindingEpoch: 2 } },
  ])
    await expect(reader.remote({ permit, signature: signed.signature }, service.connection)).rejects.toMatchObject({
      data: { code: "PERMISSION_DENIED" },
    })
})
