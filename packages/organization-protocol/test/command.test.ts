import { expect, test } from "bun:test"
import { OrganizationCommandProtocol as Command, OrganizationRuntimeProtocol as Runtime } from "../src/index"
import { signedProtocol } from "../src/signature"

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
  connectionEpoch: 2,
  commandSeq: 3,
  shareGeneration: 4,
  controlRevision: 5,
  authRevision: 6,
  admissionID: "admission",
  attemptID: "attempt",
  operation: "input",
  authorizedAt: 1,
  deadline: 30_001,
  actor: {
    kind: "account",
    subjectID: "account",
    orgID: "org",
    displayName: "Original display name",
    clientKind: "web",
    requestID: "request",
  },
  provisionalGrantID: "grant",
}

test("command permits sign every authority, sequence, actor and request claim", async () => {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const publicKey = await Runtime.publicKey(keys.publicKey)
  const signature = await Command.sign(permit, keys.privateKey)
  expect(await Command.verify(permit, signature, publicKey)).toBe(true)
  expect(await Command.verify(Object.fromEntries(Object.entries(permit).reverse()), signature, publicKey)).toBe(true)
  for (const changed of [
    { orgID: "other", actor: { ...permit.actor, orgID: "other" } },
    { deploymentIncarnation: "other" },
    { keyID: "other" },
    { requestID: "other", actor: { ...permit.actor, requestID: "other" } },
    { payloadHash: "b".repeat(64) },
    { sessionID: "other" },
    { projectID: "other" },
    { runtimeID: "other" },
    { bindingEpoch: 2 },
    { connectionEpoch: 3 },
    { commandSeq: 4 },
    { shareGeneration: 5 },
    { controlRevision: 6 },
    { authRevision: 7 },
    { admissionID: "other" },
    { attemptID: "other" },
    { operation: "pause" },
    { authorizedAt: 2 },
    { deadline: 30_002 },
    { actor: { ...permit.actor, subjectID: "other" } },
    { actor: { ...permit.actor, displayName: "Renamed" } },
    { actor: { ...permit.actor, clientKind: "desktop" } },
    { provisionalGrantID: "other" },
    { schemaVersion: 2 },
    { purpose: "runtime-connect" },
    { payload: "Private input" },
  ])
    expect(await Command.verify({ ...permit, ...changed }, signature, publicKey)).toBe(false)
  expect(await Command.verify(permit, "0".repeat(128), publicKey)).toBe(false)
  expect(await Command.verify(permit, signature, "invalid")).toBe(false)
  const other = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  expect(await Command.verify(permit, signature, await Runtime.publicKey(other.publicKey))).toBe(false)
})

test("proof families cannot reuse signatures even when the JSON claims are identical", async () => {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const signature = await signedProtocol(Command.Permit, "synergy.organization.runtime.proof.v1\n").sign(
    permit,
    keys.privateKey,
  )
  expect(await Command.verify(permit, signature, await Runtime.publicKey(keys.publicKey))).toBe(false)
})

test("command permits reject ambiguous actors, unbounded lifetimes and unsafe counters", () => {
  expect(Command.Permit.parse(permit)).toEqual(permit)
  for (const change of [
    { actor: { ...permit.actor, orgID: "other" } },
    { actor: { ...permit.actor, requestID: "other" } },
    { actor: { ...permit.actor, kind: "system" } },
    { actor: { ...permit.actor, clientKind: "runtime" } },
    { actor: { ...permit.actor, role: "owner" } },
    { actor: { ...permit.actor, subjectID: "../account" } },
    { deadline: 1 },
    { deadline: 60_002 },
    { authorizedAt: -1 },
    { bindingEpoch: 0 },
    { commandSeq: Number.MAX_SAFE_INTEGER + 1 },
    { operation: "any-runtime-route" },
  ])
    expect(Command.Permit.safeParse({ ...permit, ...change }).success).toBe(false)
})
