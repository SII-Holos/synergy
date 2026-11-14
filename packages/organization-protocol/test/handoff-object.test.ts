import { expect, test } from "bun:test"
import { OrganizationHandoffObjectProtocol as ObjectRead } from "../src/handoff-object"
import { OrganizationHandoffProtocol as Handoff } from "../src/handoff"
import { OrganizationRuntimeProtocol as Runtime } from "../src/runtime"

const proof = {
  schemaVersion: 1,
  purpose: "handoff-object-read",
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
  runtimeID: "target",
  connectionEpoch: 3,
  requestID: "object-range",
  manifestHash: "a".repeat(64),
  range: { hash: "b".repeat(64), offset: 131072, length: 131072 },
  issuedAt: 100,
  expiresAt: 30100,
} as const

test("handoff object reads require their exact destination, epoch tuple, immutable package, finite range and signature domain", async () => {
  expect(ObjectRead.Proof.parse(proof)).toEqual(proof)
  for (const changed of [
    { ...proof, runtimeID: "source" },
    { ...proof, toEpoch: 1 },
    { ...proof, expiresAt: 30101 },
    { ...proof, range: { ...proof.range, length: 131073 } },
    { ...proof, path: "/private/other-session" },
    { ...proof, purpose: "session-command" },
  ])
    expect(ObjectRead.Proof.safeParse(changed).success).toBe(false)
  const key = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const publicKey = await Runtime.publicKey(key.publicKey)
  const signature = await ObjectRead.sign(proof, key.privateKey)
  expect(await ObjectRead.verify(proof, signature, publicKey)).toBe(true)
  for (const changed of [
    { ...proof, handoffID: "another" },
    { ...proof, sessionID: "another" },
    { ...proof, deploymentIncarnation: "restored" },
    { ...proof, connectionEpoch: 4 },
    { ...proof, mappingPlanRevision: 2 },
    { ...proof, shareGeneration: 5 },
    { ...proof, manifestHash: "c".repeat(64) },
    { ...proof, range: { ...proof.range, offset: 0 } },
  ])
    expect(await ObjectRead.verify(changed, signature, publicKey)).toBe(false)
  expect(await Handoff.verifyProof(proof, signature, publicKey)).toBe(false)
})
