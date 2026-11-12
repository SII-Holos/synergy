import { expect, test } from "bun:test"
import { OrganizationHandoffProtocol as Handoff } from "../src/handoff"
import { OrganizationRuntimeProtocol as Runtime } from "../src/runtime"

const tuple = {
  schemaVersion: 1,
  orgID: "org",
  deploymentIncarnation: "deployment",
  handoffID: "handoff",
  sessionID: "session",
  sourceRuntimeID: "source",
  targetRuntimeID: "target",
  fromEpoch: 1,
  toEpoch: 2,
  mappingPlanRevision: 1,
  shareGeneration: 4,
} as const
const plan = {
  ...tuple,
  purpose: "handoff-machine",
  operation: "prepare-source",
  requestID: "explicit-attempt",
  keyID: "authority",
  runtimeID: "source",
  connectionEpoch: 5,
  commandSeq: 9,
  controlRevision: 11,
  authRevision: 1,
  actor: {
    kind: "account",
    orgID: "org",
    subjectID: "creator",
    displayName: "Creator",
    clientKind: "web",
    requestID: "explicit-attempt",
  },
  sourceBinding: {
    schemaVersion: 1,
    orgID: "org",
    projectID: "project",
    creatorID: "creator",
    driverRuntimeID: "source",
    bindingEpoch: 1,
  },
  issuedAt: 100,
  expiresAt: 30100,
} as const

test("machine plans bind an existing handoff, canonical source, operation, watermark and finite machine connection", async () => {
  expect(Handoff.MachinePlan.parse(plan)).toEqual(plan)
  for (const changed of [
    { ...plan, sourceBinding: undefined },
    { ...plan, runtimeID: "target" },
    { ...plan, sourceBinding: { ...plan.sourceBinding, driverRuntimeID: "target" } },
    { ...plan, sourceBinding: { ...plan.sourceBinding, bindingEpoch: 2 } },
    { ...plan, sourceBinding: { ...plan.sourceBinding, orgID: "another-org" } },
    { ...plan, toEpoch: 1 },
    { ...plan, expiresAt: 30101 },
    { ...plan, input: { parts: [{ type: "text", text: "Do not admit input through a handoff plan" }] } },
    { ...plan, operation: "continue" },
  ])
    expect(Handoff.MachinePlan.safeParse(changed).success).toBe(false)
  expect(Handoff.Drive.safeParse({ operation: "object", requestID: "request" }).success).toBe(false)
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const publicKey = await Runtime.publicKey(keys.publicKey)
  const signature = await Handoff.signMachinePlan(plan, keys.privateKey)
  expect(await Handoff.verifyMachinePlan(plan, signature, publicKey)).toBe(true)
  for (const changed of [
    { ...plan, requestID: "another-attempt" },
    { ...plan, connectionEpoch: 6 },
    { ...plan, commandSeq: 10 },
    { ...plan, controlRevision: 12 },
    { ...plan, sourceBinding: { ...plan.sourceBinding, creatorID: "another-creator" } },
  ])
    expect(await Handoff.verifyMachinePlan(changed, signature, publicKey)).toBe(false)
  expect(await Handoff.verifyPermit(plan, signature, publicKey)).toBe(false)
})

test("machine replies cannot switch handoff facts or use an object range as arbitrary private content", async () => {
  const input = Handoff.MachinePlan.parse({
    ...plan,
    operation: "object",
    actor: {
      kind: "system",
      orgID: plan.orgID,
      subjectID: plan.targetRuntimeID,
      displayName: "Destination Runtime",
      clientKind: "runtime",
      requestID: plan.requestID,
    },
    manifestHash: "a".repeat(64),
    object: { hash: "b".repeat(64), offset: 4, length: 2 },
  })
  expect(Handoff.MachinePlan.safeParse({ ...input, actor: plan.actor }).success).toBe(false)
  expect(
    Handoff.MachinePlan.safeParse({ ...input, actor: { ...input.actor, subjectID: "foreign-runtime" } }).success,
  ).toBe(false)
  expect(Handoff.MachinePlan.safeParse({ ...plan, actor: input.actor }).success).toBe(false)
  const reply = Handoff.MachineResult.parse({
    handoffID: input.handoffID,
    requestID: input.requestID,
    runtimeID: input.runtimeID,
    operation: input.operation,
    state: "complete",
    stage: "source-frozen",
    revision: "c".repeat(64),
    requirements: [],
    facts: [],
    object: { hash: "b".repeat(64), offset: 4, nextOffset: 6, totalBytes: 6, data: "YWk", complete: true },
  })
  expect(Handoff.matchesMachine(input, reply)).toBe(true)
  for (const changed of [
    { ...reply, handoffID: "another" },
    { ...reply, requestID: "another" },
    { ...reply, runtimeID: "target" },
    { ...reply, object: { ...reply.object, hash: "d".repeat(64) } },
    { ...reply, object: { ...reply.object, offset: 0 } },
  ])
    expect(Handoff.matchesMachine(input, changed)).toBe(false)
  expect(Handoff.MachinePlan.safeParse({ ...input, object: { ...input.object, length: 128 * 1024 + 1 } }).success).toBe(
    false,
  )
  expect(Handoff.MachineResult.safeParse({ ...reply, object: { ...reply.object, nextOffset: 7 } }).success).toBe(false)
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const proof = Handoff.Proof.parse({
    ...tuple,
    purpose: "source-frozen",
    manifestHash: "a".repeat(64),
    commandSeq: 9,
    receivedSeq: 9,
    compatibilityHash: "b".repeat(64),
    closureHash: "c".repeat(64),
    fileClosureHash: null,
    workspaceMoveReceiptHash: null,
    paused: true,
    drained: true,
  })
  const fact = { proof, signature: await Handoff.signProof(proof, keys.privateKey) }
  expect(Handoff.Proof.safeParse({ ...proof, fileClosureHash: undefined }).success).toBe(false)
  expect(Handoff.Proof.safeParse({ ...proof, fileClosureHash: "invalid" }).success).toBe(false)
  expect(
    await Handoff.verifyProof(
      { ...proof, fileClosureHash: "d".repeat(64) },
      fact.signature,
      await Runtime.publicKey(keys.publicKey),
    ),
  ).toBe(false)
  expect(
    Handoff.matchesMachine(plan, { ...reply, operation: plan.operation, object: undefined, stage: "idle", facts: [] }),
  ).toBe(false)
  expect(Handoff.matchesMachine(plan, { ...reply, operation: plan.operation, object: undefined, facts: [fact] })).toBe(
    true,
  )
  expect(
    Handoff.matchesMachine(plan, {
      ...reply,
      operation: plan.operation,
      object: undefined,
      facts: [{ ...fact, proof: { ...proof, commandSeq: 8 } }],
    }),
  ).toBe(false)
  expect(
    Handoff.matchesMachine(plan, {
      ...reply,
      operation: plan.operation,
      object: undefined,
      facts: [{ ...fact, proof: { ...proof, mappingPlanRevision: 2 } }],
    }),
  ).toBe(false)
})
