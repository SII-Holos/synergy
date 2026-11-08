import { expect, test } from "bun:test"
import { OrganizationGatewayProtocol as Gateway, OrganizationRuntimeProtocol as Runtime } from "../src/index"

test("gateway proofs bind one finite call and separate Runtime request authority from worker capability", async () => {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const publicKey = await Runtime.publicKey(keys.publicKey)
  const target = {
    orgID: "org",
    deploymentIncarnation: "deployment",
    runtimeID: "runtime",
    connectionEpoch: 1,
    grantID: "grant",
    sessionID: "session",
    rootID: "root",
    bindingEpoch: 1,
    resourceID: "model",
    callID: "call",
  }
  const proof = Gateway.Proof.parse({
    ...target,
    schemaVersion: 1,
    purpose: "gateway-call",
    issuedAt: 1,
    expiresAt: 30_001,
  })
  const signature = await Gateway.signRequest(proof, keys.privateKey)
  expect(await Gateway.verifyRequest(proof, signature, publicKey)).toBeTrue()
  for (const key of Object.keys(target) as (keyof typeof target)[]) {
    const changed = { ...proof, [key]: typeof target[key] === "number" ? 2 : "other" }
    expect(await Gateway.verifyRequest(changed, signature, publicKey)).toBeFalse()
  }
  for (const changed of [
    { ...proof, expiresAt: 60_002 },
    { ...proof, expiresAt: 1 },
    { ...proof, endpoint: "https://arbitrary.example" },
    { ...proof, headers: { authorization: "secret" } },
  ])
    expect(Gateway.Proof.safeParse(changed).success).toBeFalse()
  const permit = Gateway.Permit.parse({
    ...target,
    schemaVersion: 1,
    purpose: "gateway-invocation",
    keyID: "service-key",
    resourceRevision: 1,
    protocol: "openai-compatible",
    modelID: "fixture",
    requestBytes: 1024,
    responseBytes: 2048,
    timeoutMs: 60_000,
    issuedAt: 1,
    expiresAt: 60_001,
  })
  const authorization = { permit, signature: await Gateway.signPermit(permit, keys.privateKey) }
  const token = Gateway.encode(authorization)
  expect(Gateway.decode(token)).toEqual(authorization)
  expect(await Gateway.verifyPermit(permit, signature, publicKey)).toBeFalse()
  expect(await Gateway.verifyPermit(permit, authorization.signature, publicKey)).toBeTrue()
  expect(() => Gateway.decode(token + "!")).toThrow()
  expect(() => Gateway.decode("a".repeat(32_769))).toThrow()
  const reserved = { ...target, state: "reserved", createdAt: 1 }
  expect(Gateway.Receipt.safeParse(reserved).success).toBeTrue()
  expect(Gateway.Receipt.safeParse({ ...reserved, startedAt: 2 }).success).toBeFalse()
  expect(Gateway.Receipt.safeParse({ ...reserved, state: "started" }).success).toBeFalse()
  expect(Gateway.Receipt.safeParse({ ...reserved, state: "response_complete" }).success).toBeFalse()
})
