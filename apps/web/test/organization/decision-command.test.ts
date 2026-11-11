import { expect, test } from "bun:test"
import {
  createOrganizationDecisionCommands,
  confirmOrganizationDecision,
} from "../../src/organization/decision-command"
import type { OrganizationCommandProtocol as Command } from "@ericsanchezok/synergy-organization-protocol"

const request = {
  schemaVersion: 1,
  orgID: "org-one",
  requestID: "logical-one",
  projectID: "project-one",
  runtimeID: "runtime-one",
  sessionID: "session-one",
  decision: {
    operation: "decision",
    kind: "question",
    requestID: "native-one",
    reply: "answer",
    answers: [["private-answer"]],
  },
} satisfies Command.DecisionRequest
function memory() {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
}
test("a sensitive logical decision retains its exact command only in memory and restores metadata for reconciliation", async () => {
  const storage = memory()
  const ledger = createOrganizationDecisionCommands(storage, "connection-one", "session-one")
  const entry = await ledger.begin(request, true)
  expect(entry.command).toEqual(request)
  expect([...storage.values.values()].join(" ")).not.toContain("private-answer")
  const restored = createOrganizationDecisionCommands(storage, "connection-one", "session-one").pending()
  expect(restored).toHaveLength(1)
  expect(restored[0]).toMatchObject({
    requestID: "logical-one",
    nativeID: "native-one",
    kind: "question",
    sourceSessionID: "session-one",
    sensitive: true,
  })
  expect(restored[0]?.command).toBeUndefined()
  expect(restored[0]?.requestHash).toMatch(/^[a-f0-9]{64}$/)
  expect(createOrganizationDecisionCommands(storage, "connection-two", "session-one").pending()).toHaveLength(0)
  expect(() => ledger.clear("native-one", "wrong-logical")).not.toThrow()
  expect(ledger.pending()).toHaveLength(1)
  ledger.clear("native-one", "logical-one")
  expect(ledger.pending()).toHaveLength(0)
})
test("a retained decision rejects a changed answer or new logical ID and cannot silently regain a password after reload", async () => {
  const storage = memory()
  const ledger = createOrganizationDecisionCommands(storage, "connection-one", "session-one")
  await ledger.begin(request, true)
  await expect(ledger.begin({ ...request, requestID: "other-logical" }, true)).rejects.toThrow()
  await expect(
    ledger.begin({ ...request, decision: { ...request.decision, answers: [["other-answer"]] } }, true),
  ).rejects.toThrow()
  const restored = createOrganizationDecisionCommands(storage, "connection-one", "session-one")
  const entry = await restored.begin(request, true)
  expect(entry.command).toBeUndefined()
  expect([...storage.values.values()].join(" ")).not.toContain("private-answer")
})
test("ordinary decisions restore their original command and a persistence failure prevents admission", async () => {
  const storage = memory()
  await createOrganizationDecisionCommands(storage, "connection-one", "session-one").begin(request, false)
  expect(createOrganizationDecisionCommands(storage, "connection-one", "session-one").pending()[0]?.command).toEqual(
    request,
  )
  const failed = createOrganizationDecisionCommands(
    {
      ...storage,
      setItem() {
        throw new Error("Storage denied")
      },
    },
    "other",
    "session-one",
  )
  await expect(failed.begin(request, true)).rejects.toThrow("Storage denied")
  expect(failed.pending()).toHaveLength(0)
})
test("a password-free receipt must match the original digest, actor, binding and native outcome kind", async () => {
  const ledger = createOrganizationDecisionCommands(memory(), "connection-one", "session-one")
  const entry = await ledger.begin(request, true)
  const permit = {
    schemaVersion: 1,
    purpose: "session-command",
    orgID: request.orgID,
    deploymentIncarnation: "deployment",
    keyID: "key",
    requestID: request.requestID,
    payloadHash: entry.requestHash,
    sessionID: request.sessionID,
    projectID: request.projectID,
    runtimeID: request.runtimeID,
    bindingEpoch: 1,
    connectionEpoch: 1,
    commandSeq: 1,
    shareGeneration: 0,
    controlRevision: 0,
    authRevision: 1,
    admissionID: "admission",
    attemptID: "attempt",
    operation: "decision",
    authorizedAt: 1,
    deadline: 30001,
    actor: {
      kind: "account",
      subjectID: "account-one",
      orgID: request.orgID,
      displayName: "Account",
      clientKind: "web",
      requestID: request.requestID,
    },
  } as const
  const winner = {
    sessionID: request.sessionID,
    requestID: request.decision.requestID,
    decidedAt: 2,
    outcome: { kind: "question", reply: "answer" },
  } as const
  const accepted = {
    schemaVersion: 1,
    permit,
    acceptedAt: 2,
    intakeSeq: 1,
    effect: {
      kind: "decision",
      sourceSessionID: request.sessionID,
      requestID: request.decision.requestID,
      decision: { status: "resolved", winner },
    },
  } as const
  expect(confirmOrganizationDecision(entry, accepted, "account-one", 1)).toEqual(accepted)
  for (const value of [
    { ...accepted, permit: { ...permit, payloadHash: "b".repeat(64) } },
    { ...accepted, permit: { ...permit, bindingEpoch: 2 } },
    { ...accepted, permit: { ...permit, actor: { ...permit.actor, subjectID: "another-account" } } },
    {
      ...accepted,
      effect: {
        ...accepted.effect,
        decision: { status: "already_resolved", winner: { ...winner, outcome: { kind: "permission", reply: "once" } } },
      },
    },
  ])
    expect(() => confirmOrganizationDecision(entry, value, "account-one", 1)).toThrow()
})
