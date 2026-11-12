import { expect, test } from "bun:test"
import { OrganizationHandoffRecovery as Recovery } from "../src/handoff-recovery"
import { OrganizationHandoffProtocol as Handoff } from "../src/handoff"
import { OrganizationRuntimeProtocol as Runtime } from "../src/runtime"

test("machine cleanup signatures cannot become ordinary connection or execution authority", async () => {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const publicKey = await Runtime.publicKey(keys.publicKey)
  const proof = Recovery.Proof.parse({
    schemaVersion: 1,
    purpose: "handoff-cleanup-recovery",
    orgID: "org",
    deploymentIncarnation: "deployment",
    runtimeID: "target",
    requestID: "query",
    issuedAt: 100,
    expiresAt: 30100,
    query: { operation: "discover", page: { limit: 1 } },
  })
  const signature = await Recovery.sign(proof, keys.privateKey)
  expect(await Recovery.verify(proof, signature, publicKey)).toBe(true)
  expect(await Runtime.verify(proof, signature, publicKey)).toBe(false)
  expect(await Handoff.verifyMachinePlan(proof, signature, publicKey)).toBe(false)
  for (const changed of [
    { ...proof, purpose: "runtime-connect" },
    { ...proof, runtimeID: "another" },
    { ...proof, expiresAt: 30101 },
    { ...proof, query: { operation: "prepare-target" } },
    { ...proof, query: { ...proof.query, sessionID: "new-session" } },
    { ...proof, command: "continue" },
  ])
    expect(await Recovery.verify(changed, signature, publicKey)).toBe(false)
  const binding = {
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
    shareGeneration: 0,
  }
  const inspect = { ...proof, query: { operation: "inspect-target", binding, manifestHash: "a".repeat(64) } }
  expect(Recovery.Proof.safeParse(inspect).success).toBe(true)
  expect(Recovery.Proof.safeParse({ ...inspect, runtimeID: "source" }).success).toBe(false)
  expect(
    Recovery.Proof.safeParse({
      ...inspect,
      query: { ...inspect.query, binding: { ...binding, deploymentIncarnation: "another" } },
    }).success,
  ).toBe(false)
  expect(
    Recovery.Descriptor.safeParse({ ...binding, manifestHash: "a".repeat(64), currentDriver: "private" }).success,
  ).toBe(false)
})
