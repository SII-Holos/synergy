import { expect, test } from "bun:test"
import { OrganizationCommandProtocol as Command } from "@ericsanchezok/synergy-organization-protocol"
import { organizationCommandAccepted } from "../../src/organization/command-receipt"

const permit: Command.Permit = {
  schemaVersion: 1,
  purpose: "session-command",
  orgID: "org",
  deploymentIncarnation: "deployment",
  keyID: "key",
  requestID: "request",
  payloadHash: "a".repeat(64),
  sessionID: "session",
  projectID: "project",
  runtimeID: "runtime",
  bindingEpoch: 1,
  connectionEpoch: 1,
  commandSeq: 1,
  shareGeneration: 0,
  controlRevision: 0,
  authRevision: 1,
  admissionID: "admission",
  attemptID: "attempt",
  operation: "input",
  authorizedAt: 1,
  deadline: 30001,
  actor: {
    kind: "account",
    subjectID: "account",
    orgID: "org",
    displayName: "Account",
    clientKind: "web",
    requestID: "request",
  },
}
const request: Command.InputRequest = {
  schemaVersion: 1,
  orgID: "org",
  requestID: "request",
  sessionID: "session",
  projectID: "project",
  runtimeID: "runtime",
  input: { operation: "input", mode: "task", parts: [{ type: "text", text: "Retain until confirmed" }] },
}
const accepted = {
  schemaVersion: 1,
  permit,
  acceptedAt: 2,
  intakeSeq: 1,
  effect: { kind: "inbox", itemID: "item", messageID: "message", mode: "task" },
} as const
test("only an acceptance for the exact immutable command and account can confirm a draft", () => {
  expect(organizationCommandAccepted(request, accepted, "account")).toEqual(accepted)
  for (const value of [
    { unrelated: "success" },
    { ...accepted, permit: { ...permit, sessionID: "other-session" } },
    {
      ...accepted,
      permit: { ...permit, requestID: "other-request", actor: { ...permit.actor, requestID: "other-request" } },
    },
    { ...accepted, permit: { ...permit, actor: { ...permit.actor, subjectID: "other-account" } } },
    { ...accepted, effect: { ...accepted.effect, mode: "context" } },
  ])
    expect(() => organizationCommandAccepted(request, value, "account")).toThrow()
})
test("a decision acknowledgement cannot substitute a different native question or permission outcome", () => {
  const decision: Command.DecisionRequest = {
    schemaVersion: 1,
    orgID: "org",
    requestID: "request",
    sessionID: "session",
    projectID: "project",
    runtimeID: "runtime",
    decision: {
      operation: "decision",
      kind: "question",
      requestID: "native",
      reply: "answer",
      answers: [["selected"]],
    },
  }
  const value = {
    schemaVersion: 1,
    permit: { ...permit, operation: "decision" },
    acceptedAt: 2,
    intakeSeq: 1,
    effect: {
      kind: "decision",
      sourceSessionID: "session",
      requestID: "native",
      decision: {
        status: "already_resolved",
        winner: {
          sessionID: "session",
          requestID: "native",
          decidedAt: 2,
          outcome: { kind: "permission", reply: "once" },
        },
      },
    },
  }
  expect(() => organizationCommandAccepted(decision, value, "account")).toThrow()
})
