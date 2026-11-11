import { expect, test } from "bun:test"
import {
  prepareDecisionOutboxRecord,
  decisionOutboxCommandMatches,
  confirmDecisionOutboxReceipt,
} from "../../src/organization/decision-outbox-record"
import type { OrganizationCommandProtocol as Command } from "@ericsanchezok/synergy-organization-protocol"

const owner = {
  connectionKey: "connection-one",
  accountID: "account-one",
  projectID: "project-one",
  rootSessionID: "session-one",
  sourceSessionID: "session-one",
}
const binding = {
  schemaVersion: 1,
  orgID: "org-one",
  projectID: "project-one",
  creatorID: "account-one",
  driverRuntimeID: "runtime-one",
  bindingEpoch: 3,
} as const
const command = {
  schemaVersion: 1,
  orgID: "org-one",
  requestID: "logical-one",
  sessionID: "session-one",
  projectID: "project-one",
  runtimeID: "runtime-one",
  decision: {
    operation: "decision",
    kind: "question",
    requestID: "native-one",
    reply: "answer",
    answers: [["private-answer"]],
  },
} satisfies Command.DecisionRequest
test("paged outbox headers retain the exact target, digest and binding without the original answer", async () => {
  const record = await prepareDecisionOutboxRecord({ owner, binding, command, sensitive: true, createdAt: 1 })
  expect(record).toMatchObject({
    ...owner,
    orgID: "org-one",
    requestID: "logical-one",
    nativeID: "native-one",
    bindingEpoch: 3,
    sensitive: true,
    version: 1,
  })
  expect(JSON.stringify(record)).not.toContain("private-answer")
  expect(await decisionOutboxCommandMatches(record, command)).toBe(true)
  expect(
    await decisionOutboxCommandMatches(record, {
      ...command,
      decision: { ...command.decision, answers: [["different"]] },
    }),
  ).toBe(false)
})
test("a different root, source, project or executing Runtime cannot become the pending record owner", async () => {
  for (const changed of [
    { rootSessionID: "another-root" },
    { sourceSessionID: "another-source" },
    { projectID: "another-project" },
  ]) {
    await expect(
      prepareDecisionOutboxRecord({
        owner: { ...owner, ...changed },
        binding,
        command,
        sensitive: false,
        createdAt: 1,
      }),
    ).rejects.toThrow()
  }
  await expect(
    prepareDecisionOutboxRecord({
      owner,
      binding: { ...binding, driverRuntimeID: "other-runtime" },
      command,
      sensitive: true,
      createdAt: 1,
    }),
  ).rejects.toThrow()
})
test("canonical question payloads above an IPC frame remain valid outbox records", async () => {
  const large = { ...command, decision: { ...command.decision, answers: [["汉".repeat(90_000)]] } }
  const record = await prepareDecisionOutboxRecord({ owner, binding, command: large, sensitive: true, createdAt: 1 })
  expect(await decisionOutboxCommandMatches(record, large)).toBe(true)
})

test("an old logical receipt remains bound to its recorded account, payload and execution epoch", async () => {
  const record = await prepareDecisionOutboxRecord({ owner, binding, command, sensitive: true, createdAt: 1 })
  const permit: Command.Permit = {
    schemaVersion: 1,
    purpose: "session-command",
    orgID: command.orgID,
    deploymentIncarnation: "deployment",
    keyID: "key",
    requestID: command.requestID,
    payloadHash: record.requestHash,
    sessionID: command.sessionID,
    projectID: command.projectID,
    runtimeID: command.runtimeID,
    bindingEpoch: 3,
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
      subjectID: owner.accountID,
      orgID: command.orgID,
      displayName: "Account",
      clientKind: "web",
      requestID: command.requestID,
    },
  }
  const winner = {
    sessionID: command.sessionID,
    requestID: command.decision.requestID,
    decidedAt: 2,
    outcome: { kind: "question", reply: "reject" },
  } as const
  const value = {
    schemaVersion: 1,
    permit,
    acceptedAt: 2,
    intakeSeq: 1,
    effect: {
      kind: "decision",
      sourceSessionID: owner.sourceSessionID,
      requestID: record.nativeID,
      decision: { status: "already_resolved", winner },
    },
  } as const
  expect(confirmDecisionOutboxReceipt(record, value)).toEqual(value)
  for (const changed of [
    { ...value, permit: { ...permit, payloadHash: "a".repeat(64) } },
    { ...value, permit: { ...permit, bindingEpoch: 4 } },
    { ...value, permit: { ...permit, actor: { ...permit.actor, subjectID: "another-account" } } },
    { ...value, effect: { ...value.effect, sourceSessionID: "another-source" } },
    {
      ...value,
      effect: {
        ...value.effect,
        decision: { status: "already_resolved", winner: { ...winner, outcome: { kind: "permission", reply: "once" } } },
      },
    },
  ])
    expect(() => confirmDecisionOutboxReceipt(record, changed)).toThrow()
})
