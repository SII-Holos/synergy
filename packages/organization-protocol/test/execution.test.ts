import { expect, test } from "bun:test"
import {
  OrganizationCommandProtocol as Command,
  OrganizationExecutionProtocol as Execution,
  OrganizationRuntimeProtocol as Runtime,
} from "../src/index"
import { signedProtocol } from "../src/signature"

function proof(): Execution.BindingProof {
  const permit = Command.Permit.parse({
    schemaVersion: 1,
    purpose: "session-command",
    orgID: "org",
    deploymentIncarnation: "deployment",
    keyID: "service-key",
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
    deadline: 30_001,
    actor: {
      kind: "account",
      subjectID: "account",
      orgID: "org",
      displayName: "Author",
      clientKind: "web",
      requestID: "request",
    },
    provisionalGrantID: "grant",
  })
  return Execution.BindingProof.parse({
    schemaVersion: 1,
    purpose: "execution-root-binding",
    orgID: "org",
    deploymentIncarnation: "deployment",
    runtimeID: "runtime",
    connectionEpoch: 1,
    rootID: "root",
    issuedAt: 10,
    expiresAt: 30_010,
    receipt: {
      attempt: { schemaVersion: 1, permit, receivedAt: 2, status: "accepted", acceptedAttemptID: "attempt" },
      accepted: {
        schemaVersion: 1,
        permit,
        acceptedAt: 2,
        intakeSeq: 1,
        effect: { kind: "inbox", mode: "task", itemID: "input", messageID: "root" },
      },
    },
  })
}

test("execution binding signatures cover the complete native receipt, root and finite machine authority", async () => {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const publicKey = await Runtime.publicKey(keys.publicKey)
  const original = proof()
  const signature = await Execution.signBinding(original, keys.privateKey)
  expect(await Execution.verifyBinding(original, signature, publicKey)).toBeTrue()
  for (const change of [
    (p: Execution.BindingProof) => {
      p.connectionEpoch++
    },
    (p: Execution.BindingProof) => {
      p.expiresAt++
    },
    (p: Execution.BindingProof) => {
      p.issuedAt++
    },
    (p: Execution.BindingProof) => {
      p.rootID = p.receipt.accepted!.effect.messageID = "other-root"
    },
    (p: Execution.BindingProof) => {
      p.receipt.attempt.permit.provisionalGrantID = "other-grant"
      p.receipt.accepted!.permit.provisionalGrantID = "other-grant"
    },
  ]) {
    const changed = structuredClone(original)
    change(changed)
    expect(Execution.BindingProof.safeParse(changed).success).toBeTrue()
    expect(await Execution.verifyBinding(changed, signature, publicKey)).toBeFalse()
  }
  const otherDomain = signedProtocol(Execution.BindingProof, "different-proof-family\n")
  expect(
    await Execution.verifyBinding(original, await otherDomain.sign(original, keys.privateKey), publicKey),
  ).toBeFalse()
  for (const changed of [
    { ...original, rootID: "forged" },
    { ...original, receipt: { ...original.receipt, accepted: undefined } },
    { ...original, expiresAt: original.issuedAt + 60_001 },
    { ...original, expiresAt: original.issuedAt },
    { ...original, arbitrary: true },
  ])
    expect(Execution.BindingProof.safeParse(changed).success).toBeFalse()
})

test("resource selections bound each call without imposing a lifetime task quota", () => {
  const selection = { modelResourceID: "model", connectionResourceIDs: ["business"] }
  expect(Execution.resourceIDs(Execution.Selection.parse(selection))).toEqual(["model", "business"])
  for (const changed of [
    { ...selection, connectionResourceIDs: ["model"] },
    { ...selection, connectionResourceIDs: ["business", "business"] },
    { ...selection, endpoint: "https://other.example" },
    { ...selection, connectionResourceIDs: Array.from({ length: 33 }, (_, i) => `resource-${i}`) },
  ])
    expect(Execution.Selection.safeParse(changed).success).toBeFalse()
  expect(Execution.Limits.parse({ requestBytes: 1, responseBytes: 1 })).toEqual({ requestBytes: 1, responseBytes: 1 })
  expect(Execution.Limits.safeParse({ calls: 1, requestBytes: 1, responseBytes: 1 }).success).toBeFalse()
  expect(Execution.Limits.safeParse({ requestBytes: 17 * 1024 * 1024, responseBytes: 1 }).success).toBeFalse()
  expect(Execution.Limits.safeParse({ requestBytes: 1, responseBytes: 65 * 1024 * 1024 }).success).toBeFalse()
})

test("resource description proves accepted input without claiming a materialized root or invocation authority", async () => {
  const { purpose: _, rootID: __, ...received } = proof()
  const description = Execution.DescriptionProof.parse({ ...received, purpose: "execution-resource-description" })
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const publicKey = await Runtime.publicKey(keys.publicKey)
  const signature = await Execution.signDescription(description, keys.privateKey)
  expect(await Execution.verifyDescription(description, signature, publicKey)).toBeTrue()
  expect(await Execution.verifyBinding(proof(), signature, publicKey)).toBeFalse()
  expect(Execution.DescriptionProof.safeParse({ ...description, rootID: "unproven-root" }).success).toBeFalse()
  expect(
    Execution.DescriptionProof.safeParse({ ...description, receipt: { ...description.receipt, accepted: undefined } })
      .success,
  ).toBeFalse()
  expect(
    Execution.DescriptionProof.safeParse({ ...description, expiresAt: description.issuedAt + 60_001 }).success,
  ).toBeFalse()
})

test("resource release proofs bind the accepted root and retention generation in a distinct signing domain", async () => {
  const original = Execution.ReleaseProof.parse({
    ...proof(),
    purpose: "execution-resources-release",
    generation: 1,
    outcome: "completed",
  })
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const publicKey = await Runtime.publicKey(keys.publicKey)
  const signature = await Execution.signRelease(original, keys.privateKey)
  expect(await Execution.verifyRelease(original, signature, publicKey)).toBeTrue()
  expect(await Execution.verifyBinding(proof(), signature, publicKey)).toBeFalse()
  for (const change of [
    { generation: 2 },
    { outcome: "cancelled" as const },
    { connectionEpoch: 2 },
    { expiresAt: original.expiresAt + 1 },
  ])
    expect(await Execution.verifyRelease({ ...original, ...change }, signature, publicKey)).toBeFalse()
  for (const change of [
    { generation: -1 },
    { generation: 0.5 },
    { generation: 0 },
    { outcome: "running" },
    { rootID: "other-root" },
    { expiresAt: original.issuedAt + 60_001 },
    { arbitrary: true },
  ])
    expect(Execution.ReleaseProof.safeParse({ ...original, ...change }).success).toBeFalse()
  expect(Execution.ReleaseProof.safeParse({ ...original, generation: 0, outcome: "cancelled" }).success).toBeTrue()
})
