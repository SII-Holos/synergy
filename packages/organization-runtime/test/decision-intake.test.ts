import { expect, spyOn, test } from "bun:test"
import {
  OrganizationCommandProtocol as Command,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { PermissionRules } from "@ericsanchezok/synergy-harness/permission/rules"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { createCommandIntake } from "../src/command-intake"
import { registerSessionSchema } from "../src/session-schema"
import { OrganizationIntakePath as Keys } from "../src/storage/path"

const binding = {
  schemaVersion: 1 as const,
  orgID: "org-decisions",
  projectID: "project-decisions",
  creatorID: "A",
  driverRuntimeID: "runtime-decisions",
  bindingEpoch: 1,
}
async function authority() {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const identity = {
    schemaVersion: 1 as const,
    orgID: binding.orgID,
    deploymentIncarnation: "deployment-decisions",
    keyID: "fixture-key",
    publicKey: await Runtime.publicKey(keys.publicKey),
  }
  return {
    receiver: () =>
      createCommandIntake({
        identity,
        runtimeID: binding.driverRuntimeID,
        connectionEpoch: 1,
        signal: new AbortController().signal,
      }),
    async delivery(
      sessionID: string,
      decision: Command.Decision,
      requestID = "decision-one",
      commandSeq = 1,
      actor = "B",
    ): Promise<Command.DecisionDelivery> {
      const permit: Command.Permit = {
        schemaVersion: 1,
        purpose: "session-command",
        orgID: binding.orgID,
        deploymentIncarnation: identity.deploymentIncarnation,
        keyID: identity.keyID,
        requestID,
        sessionID,
        projectID: binding.projectID,
        runtimeID: binding.driverRuntimeID,
        bindingEpoch: 1,
        connectionEpoch: 1,
        commandSeq,
        shareGeneration: 0,
        controlRevision: 0,
        authRevision: 1,
        admissionID: requestID,
        attemptID: requestID,
        operation: "decision",
        authorizedAt: Date.now(),
        deadline: Date.now() + 30_000,
        payloadHash: "0".repeat(64),
        actor: {
          kind: "account",
          orgID: binding.orgID,
          subjectID: actor,
          displayName: actor,
          clientKind: "web",
          requestID,
        },
      }
      permit.payloadHash = await Command.digestDecision(Command.decisionRequest(permit, decision))
      return { authorization: { permit, signature: await Command.sign(permit, keys.privateKey) }, decision }
    },
  }
}
async function inSession(fn: (session: Session.Info) => Promise<void>) {
  const scope = await Scope.registerProject({
    type: "project",
    id: binding.projectID,
    local: null,
    time: { created: 1, updated: 1 },
  })
  await ScopeContext.provide({
    scope,
    workspace: null,
    fn: async () => fn(await Session.create({ organization: binding, workspaceID: null })),
  })
}
function ask(sessionID: string, id = "permission-native") {
  return PermissionNext.ask({ id, sessionID, permission: "bash", patterns: ["fixture *"], ruleset: [], metadata: {} })
}
const permission: Command.Decision = {
  operation: "decision",
  kind: "permission",
  requestID: "permission-native",
  reply: "always",
}

test("signed collaboration replies use the native first winner and immutable command receipt", async () => {
  const service = await authority()
  await using runtime = await testRuntime({ register: () => registerSessionSchema(binding) })
  await runtime.run(() =>
    inSession(async (session) => {
      const pending = ask(session.id)
      const receiver = service.receiver()
      const first = await service.delivery(session.id, permission)
      const accepted = await receiver.decision(first)
      await pending
      expect(accepted).toMatchObject({
        attempt: { status: "accepted" },
        accepted: {
          permit: { actor: { subjectID: "B" } },
          effect: {
            kind: "decision",
            decision: { status: "resolved", winner: { actor: { subjectID: "B" }, outcome: { reply: "always" } } },
          },
        },
      })
      expect(await receiver.decision(first)).toEqual(accepted)
      const late = await receiver.decision(
        await service.delivery(session.id, { ...permission, reply: "reject" }, "late-decision", 2, "C"),
      )
      expect(late.accepted).toMatchObject({
        effect: { decision: { status: "already_resolved", winner: { actor: { subjectID: "B" } } } },
      })
      expect(await PermissionRules.userRuleset()).toHaveLength(1)
      expect((await receiver.query(first.authorization)).result).toEqual(accepted)
    }),
  )
})

test("native rules and decisions roll back if the surrounding signed command receipt cannot commit", async () => {
  const service = await authority()
  await using runtime = await testRuntime({ register: () => registerSessionSchema(binding) })
  await runtime.run(() =>
    inSession(async (session) => {
      const pending = ask(session.id)
      const receiver = service.receiver()
      const first = await service.delivery(session.id, permission)
      const write = Storage.write.bind(Storage)
      const failure = spyOn(Storage, "write").mockImplementation(async (key, value) => {
        if (JSON.stringify(key) === JSON.stringify(Keys.request(binding.orgID, "B", "decision-one")))
          throw new Error("fixture command receipt unavailable")
        return write(key, value)
      })
      try {
        await expect(receiver.decision(first)).rejects.toThrow("fixture command receipt unavailable")
      } finally {
        failure.mockRestore()
      }
      expect(await PermissionRules.userRuleset()).toEqual([])
      expect((await PermissionNext.list()).map((item) => item.id)).toEqual(["permission-native"])
      expect((await receiver.query(first.authorization)).result).toBeUndefined()
      const winner = await receiver.decision(
        await service.delivery(session.id, { ...permission, reply: "once" }, "replacement", 1, "C"),
      )
      await pending
      expect(winner.accepted).toMatchObject({
        effect: { decision: { status: "resolved", winner: { actor: { subjectID: "C" } } } },
      })
    }),
  )
})

test("receipt reconciliation after a lost SQL acknowledgement settles the original native caller without another admission", async () => {
  const service = await authority()
  await using runtime = await testRuntime({ register: () => registerSessionSchema(binding) })
  await runtime.run(() =>
    inSession(async (session) => {
      const pending = ask(session.id)
      expect(await PermissionRules.userRuleset()).toEqual([])
      const receiver = service.receiver()
      const first = await service.delivery(session.id, permission)
      const store = Storage.current().store
      const transaction = store.transaction.bind(store)
      const lost = spyOn(store, "transaction").mockImplementationOnce(async (body, options) => {
        await transaction(body, options)
        throw new Storage.CommitUnknownError(undefined, new Error("fixture SQL acknowledgement lost"))
      })
      try {
        await expect(receiver.decision(first)).rejects.toBeInstanceOf(Storage.CommitUnknownError)
      } finally {
        lost.mockRestore()
      }
      expect((await PermissionNext.list()).map((item) => item.id)).toEqual(["permission-native"])
      const query = await receiver.query(first.authorization)
      expect(query.result?.accepted).toMatchObject({
        permit: { requestID: "decision-one" },
        effect: { kind: "decision", decision: { winner: { actor: { subjectID: "B" } } } },
      })
      await pending
      expect(await PermissionNext.list()).toEqual([])
      expect(await PermissionRules.userRuleset()).toHaveLength(1)
    }),
  )
})
