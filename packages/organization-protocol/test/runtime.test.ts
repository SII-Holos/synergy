import { expect, test } from "bun:test"
import { OrganizationRuntimeProtocol as Runtime, OrganizationProtocol } from "../src/index"

test("an empty shared blob has one strict zero-length transport frame", () => {
  const frame = {
    type: "blob-chunk",
    connectionEpoch: 1,
    exchangeID: "empty",
    sessionID: "session",
    shareGeneration: 1,
    hash: new Bun.CryptoHasher("sha256").digest("hex"),
    offset: 0,
    totalBytes: 0,
    index: 0,
    total: 1,
    data: "",
  }
  expect(Runtime.BlobChunk.safeParse(frame).success).toBe(true)
  for (const changes of [{ offset: 1 }, { index: 1 }, { total: 2 }, { totalBytes: 1 }, { data: "AA" }])
    expect(Runtime.BlobChunk.safeParse({ ...frame, ...changes }).success).toBe(false)
})

async function keys() {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  return { pair, publicKey: await Runtime.publicKey(pair.publicKey) }
}

test("runtime registration proof binds a machine key, organization, deployment and one-use ticket", async () => {
  const first = await keys()
  const other = await keys()
  const proof = {
    purpose: "runtime-register",
    protocolVersion: 1,
    orgID: "org",
    deploymentIncarnation: "deployment",
    runtimeID: "runtime",
    ticketHash: "a".repeat(64),
  } satisfies Runtime.RegistrationProof
  const signature = await Runtime.sign(proof, first.pair.privateKey)
  expect(await Runtime.verify(proof, signature, first.publicKey)).toBe(true)
  expect(await Runtime.verify(proof, signature, other.publicKey)).toBe(false)
  for (const change of [
    { orgID: "other" },
    { deploymentIncarnation: "other" },
    { runtimeID: "other" },
    { ticketHash: "b".repeat(64) },
    { protocolVersion: 2 },
    { purpose: "runtime-connect" },
    { password: "private" },
  ])
    expect(await Runtime.verify({ ...proof, ...change }, signature, first.publicKey)).toBe(false)
  expect(await Runtime.verify(proof, "malformed", first.publicKey)).toBe(false)
  expect(await Runtime.verify(proof, signature, "malformed")).toBe(false)
})

test("connection proofs preserve all handshake claims and ignore JSON object insertion order", async () => {
  const key = await keys()
  const handshake = {
    type: "handshake",
    protocolVersion: 1,
    orgID: "org",
    deploymentIncarnation: "deployment",
    runtimeID: "runtime",
    runtimeKind: "member",
    accountID: "member",
    deviceID: "device",
    connectionEpoch: 1,
    buildVersion: "1.1.26",
    capabilities: ["bridge"],
    schemas: { session: 1, message: 1 },
  } satisfies OrganizationProtocol.Handshake
  const proof = {
    purpose: "runtime-connect",
    handshake,
    nonce: "c".repeat(64),
    issuedAt: 123,
  } satisfies Runtime.ConnectionProof
  const signature = await Runtime.sign(proof, key.pair.privateKey)
  expect(
    await Runtime.verify(
      { ...proof, handshake: { ...handshake, schemas: { message: 1, session: 1 } } },
      signature,
      key.publicKey,
    ),
  ).toBe(true)
  for (const change of [
    { connectionEpoch: 2 },
    { accountID: "other" },
    { deviceID: "other" },
    { capabilities: ["execute"] },
    { schemas: { session: 2, message: 1 } },
    { buildVersion: "different" },
    { runtimeKind: "hosted" },
  ])
    expect(await Runtime.verify({ ...proof, handshake: { ...handshake, ...change } }, signature, key.publicKey)).toBe(
      false,
    )
  expect(await Runtime.verify({ ...proof, issuedAt: 124 }, signature, key.publicKey)).toBe(false)
  expect(await Runtime.verify({ ...proof, nonce: "d".repeat(64) }, signature, key.publicKey)).toBe(false)
})

test("member registration cannot supply a different account, a hosted role or private key material", async () => {
  const key = await keys()
  const input = { deviceID: "device", publicKey: key.publicKey }
  expect(Runtime.MemberRegistration.parse(input)).toEqual(input)
  for (const extra of [{ accountID: "other" }, { runtimeKind: "hosted" }, { privateKey: "private" }, { role: "owner" }])
    expect(Runtime.MemberRegistration.safeParse({ ...input, ...extra }).success).toBe(false)
})
