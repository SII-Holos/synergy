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

test("control digests bind the observed pause and version and reject forged or unsafe control fields", async () => {
  const control: Command.Control = { operation: "continue", pausedSince: 100, controlVersion: 2 }
  const request = Command.controlRequest({ ...permit, operation: "continue" }, control)
  const hash = await Command.digestControl(request)
  for (const changed of [
    { ...request, control: { ...control, pausedSince: 101 } },
    { ...request, control: { ...control, controlVersion: 3 } },
    { ...request, sessionID: "another-session" },
    { ...request, control: { operation: "pause" as const } },
  ])
    expect(await Command.digestControl(changed)).not.toBe(hash)
  for (const changed of [
    { ...control, actor: permit.actor },
    { ...control, controlVersion: -1 },
    { ...control, controlVersion: Number.MAX_SAFE_INTEGER + 1 },
    { ...control, pausedSince: NaN },
    { operation: "continue", pausedSince: 100 },
    { operation: "pause", force: true },
  ])
    expect(Command.Control.safeParse(changed).success).toBe(false)
  expect(Command.Control.safeParse({ ...control, controlVersion: 0 }).success).toBe(true)
  expect(
    Command.ControlDelivery.safeParse({ authorization: { permit, signature: "0".repeat(128) }, control }).success,
  ).toBe(false)
  const accepted: Command.ControlAccepted = {
    schemaVersion: 1,
    permit: { ...permit, operation: "pause" },
    acceptedAt: 2,
    intakeSeq: 1,
    effect: { kind: "control", operation: "pause", controlVersion: 1, pausedSince: 100, changed: true },
  }
  expect(Command.Accepted.parse(accepted)).toEqual(accepted)
  expect(Command.Accepted.safeParse({ ...accepted, permit: { ...permit, operation: "continue" } }).success).toBe(false)
})

test("creation binds the service-selected identity and private title without accepting caller ownership fields", async () => {
  const target = Command.createRequest(
    { ...permit, operation: "create" },
    { operation: "create", title: "Private title" },
  )
  const hash = await Command.digestCreate(target)
  for (const changed of [
    { ...target, sessionID: "another-session" },
    { ...target, runtimeID: "another-runtime" },
    { ...target, creation: { operation: "create" as const, title: "Changed" } },
  ])
    expect(await Command.digestCreate(changed)).not.toBe(hash)
  const { sessionID: _, ...request } = target
  expect(Command.CreateRequest.safeParse({ ...request, sessionID: "caller-session" }).success).toBe(false)
  expect(Command.CreateRequest.safeParse({ ...request, creatorID: "another-account" }).success).toBe(false)
  const accepted: Command.CreatedAccepted = {
    schemaVersion: 1,
    permit: { ...permit, operation: "create", payloadHash: hash },
    acceptedAt: 2,
    intakeSeq: 1,
    effect: { kind: "session", sessionID: permit.sessionID },
  }
  expect(Command.Accepted.parse(accepted)).toEqual(accepted)
  expect(
    Command.Accepted.safeParse({ ...accepted, effect: { kind: "session", sessionID: "another-session" } }).success,
  ).toBe(false)
  expect(Command.Accepted.safeParse({ ...accepted, permit }).success).toBe(false)
})

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

test("input digests bind the logical request, full target and text without depending on object key order", async () => {
  const input: Command.Input = { operation: "input", mode: "task", parts: [{ type: "text", text: "Exact input 你好" }] }
  const request = Command.inputRequest(permit, input)
  const digest = await Command.digestInput(request)
  expect(digest).toMatch(/^[a-f0-9]{64}$/)
  expect(
    await Command.digestInput(Command.InputRequest.parse(Object.fromEntries(Object.entries(request).reverse()))),
  ).toBe(digest)
  for (const change of [
    { orgID: "other" },
    { requestID: "other" },
    { sessionID: "other" },
    { projectID: "other" },
    { runtimeID: "other" },
    { input: { ...input, mode: "context" as const } },
    { input: { ...input, parts: [{ type: "text" as const, text: "Exact input 你好 " }] } },
  ])
    expect(await Command.digestInput({ ...request, ...change })).not.toBe(digest)
  for (const value of [
    { ...input, actor: permit.actor },
    { ...input, parts: [{ type: "attachment", url: "file:///private/local-input" }] },
    { ...input, parts: [{ type: "text", text: "你".repeat(12_000) }] },
    { ...input, parts: [] },
  ])
    expect(Command.Input.safeParse(value).success).toBe(false)
})

test("skip authorization has a separate signature domain and binds the original command and current connection", async () => {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const publicKey = await Runtime.publicKey(keys.publicKey)
  const proof: Command.SkipPermit = {
    schemaVersion: 1,
    purpose: "session-command-skip",
    command: permit,
    connectionEpoch: 4,
    authorizedAt: 90_000,
    deadline: 120_000,
  }
  const signature = await Command.signSkip(proof, keys.privateKey)
  expect(await Command.verifySkip(proof, signature, publicKey)).toBe(true)
  expect(await Command.verifySkip({ ...proof, connectionEpoch: 5 }, signature, publicKey)).toBe(false)
  expect(await Command.verifySkip({ ...proof, command: { ...permit, commandSeq: 9 } }, signature, publicKey)).toBe(
    false,
  )
  expect(await Command.verifySkip({ ...proof, deadline: 120_001 }, signature, publicKey)).toBe(false)
  expect(await Command.verifySkip({ ...proof, deadline: 150_001 }, signature, publicKey)).toBe(false)
  const confused = await signedProtocol(Command.SkipPermit, "synergy.organization.command.permit.v1\n").sign(
    proof,
    keys.privateKey,
  )
  expect(await Command.verifySkip(proof, confused, publicKey)).toBe(false)
  expect(await Command.verify(permit, signature, publicKey)).toBe(false)
})
