import { expect, test } from "bun:test"
import { OrganizationExecutionProtocol as Execution } from "../src/execution"
import { OrganizationCommandProtocol as Command } from "../src/command"

function receipt(): Command.InputResult {
  const now = Date.now()
  const permit = Command.Permit.parse({
    schemaVersion: 1,
    purpose: "session-command",
    deploymentIncarnation: "deployment",
    keyID: "key",
    orgID: "org",
    sessionID: "session",
    projectID: "project",
    runtimeID: "runtime",
    bindingEpoch: 1,
    connectionEpoch: 1,
    commandSeq: 1,
    shareGeneration: 0,
    controlRevision: 0,
    authRevision: 1,
    requestID: "original",
    admissionID: "admission",
    attemptID: "attempt",
    operation: "input",
    actor: {
      kind: "account",
      orgID: "org",
      subjectID: "actor",
      displayName: "Actor",
      clientKind: "web",
      requestID: "original",
    },
    authorizedAt: now,
    deadline: now + 30_000,
    provisionalGrantID: "original-grant",
    payloadHash: "0".repeat(64),
  })
  return Command.InputResult.parse({
    attempt: { schemaVersion: 1, permit, receivedAt: now, status: "accepted", acceptedAttemptID: "attempt" },
    accepted: {
      schemaVersion: 1,
      permit,
      acceptedAt: now,
      intakeSeq: 1,
      effect: { kind: "inbox", itemID: "inbox", messageID: "root", mode: "task" },
    },
  })
}

test("cleanup inspection has a distinct strict signature domain and exact root/generation selectors", async () => {
  const now = Date.now()
  const value = {
    schemaVersion: 1,
    purpose: "execution-retention-inspection",
    orgID: "org",
    deploymentIncarnation: "deployment",
    runtimeID: "runtime",
    connectionEpoch: 1,
    rootID: "root",
    grantID: "original-grant",
    generation: 1,
    receipt: receipt(),
    issuedAt: now,
    expiresAt: now + 30_000,
  }
  const proof = Execution.InspectionProof.parse(value)
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("hex")
  const signature = await Execution.signInspection(proof, keys.privateKey)
  expect(await Execution.verifyInspection(proof, signature, publicKey)).toBeTrue()
  expect(await Execution.verifyDescription(proof, signature, publicKey)).toBeFalse()
  expect(await Execution.verifyBinding(proof, signature, publicKey)).toBeFalse()
  expect(await Execution.verifyInspection({ ...proof, generation: 2 }, signature, publicKey)).toBeFalse()
  expect(Execution.InspectionProof.safeParse({ ...value, rootID: "other-root" }).success).toBeFalse()
  expect(Execution.InspectionProof.safeParse({ ...value, grantID: undefined }).success).toBeFalse()
  expect(Execution.DescriptionProof.safeParse(value).success).toBeFalse()
  expect(Execution.BindingProof.safeParse(value).success).toBeFalse()
  expect(Execution.RetentionRequest.parse({ proof, signature }).proof.purpose).toBe("execution-retention-inspection")
})

test.each(["handoff", "control"] as const)(
  "cleanup inspection rejects another root for a %s-closed provisional grant",
  (kind) => {
    const accepted = receipt().accepted!
    const grant = Execution.Grant.parse({
      schemaVersion: 5,
      state: "closed",
      grantID: accepted.permit.provisionalGrantID,
      orgID: accepted.permit.orgID,
      deploymentIncarnation: accepted.permit.deploymentIncarnation,
      sessionID: accepted.permit.sessionID,
      projectID: accepted.permit.projectID,
      runtimeID: accepted.permit.runtimeID,
      bindingEpoch: accepted.permit.bindingEpoch,
      selectionRevision: 0,
      selection: {
        modelResourceID: "model",
        connectionResourceIDs: [],
        infrastructure: { workspace: null, environment: null },
      },
      limits: { requestBytes: 1024, responseBytes: 1024 },
      actor: accepted.permit.actor,
      admissionID: accepted.permit.admissionID,
      attemptID: accepted.permit.attemptID,
      createdAt: accepted.acceptedAt,
      closedAt: accepted.acceptedAt,
      ...(kind === "handoff"
        ? {
            handoffClosure: {
              rootID: accepted.effect.messageID,
              generation: 0,
              handoffID: "handoff",
              manifestHash: "1".repeat(64),
              preparedHash: "2".repeat(64),
              closedAt: accepted.acceptedAt,
            },
          }
        : {
            controlClosure: {
              rootID: accepted.effect.messageID,
              successorGrantID: "continued-grant",
              closedAt: accepted.acceptedAt,
            },
          }),
    })
    const response = Execution.Inspection.parse({
      schemaVersion: 1,
      state: "known",
      orgID: grant.orgID,
      deploymentIncarnation: grant.deploymentIncarnation,
      runtimeID: grant.runtimeID,
      connectionEpoch: 1,
      sessionID: grant.sessionID,
      bindingEpoch: grant.bindingEpoch,
      rootID: accepted.effect.messageID,
      originGrantID: grant.grantID,
      requestedGrantID: grant.grantID,
      requestedGeneration: 0,
      inspectedAt: Date.now(),
      grant,
    })
    expect(response).toMatchObject({ state: "known", rootID: "root", grant: { state: "closed" } })
    expect(Execution.Inspection.safeParse({ ...response, rootID: "another-root" }).success).toBeFalse()
  },
)
