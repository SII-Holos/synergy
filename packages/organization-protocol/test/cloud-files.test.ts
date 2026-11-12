import { expect, test } from "bun:test"
import {
  OrganizationCloudProtocol as Cloud,
  OrganizationCommandProtocol as Command,
  OrganizationExecutionProtocol as Execution,
  OrganizationRuntimeProtocol as Runtime,
} from "../src/index"
import { signedProtocol } from "../src/signature"

const reference: Cloud.FileReference = {
  orgID: "org",
  projectID: "project",
  resourceID: "resource",
  workspaceID: "workspace",
  generation: 1,
  revision: 2,
}

function binding(): Execution.BindingProof {
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

test("file requests retain exact versions and reject native paths, unsupported owners and unbounded windows", () => {
  expect(Cloud.LocalFileRequest.parse({ operation: { action: "describe" } })).toEqual({
    operation: { action: "describe" },
  })
  const read = { reference, operation: { action: "read", path: "src/a", maximumBytes: 1 } }
  expect(Cloud.LocalFileRequest.parse(read).operation).toMatchObject({ action: "read", offset: 0, maximumBytes: 1 })
  for (const path of [
    "/tmp/private",
    "../secret",
    "a/../secret",
    "a\\secret",
    "C:/private",
    "a//secret",
    "a\u0000secret",
  ])
    expect(Cloud.LocalFileRequest.safeParse({ ...read, operation: { ...read.operation, path } }).success).toBeFalse()
  for (const operation of [
    { action: "mount" },
    { action: "allocate" },
    { action: "mutate", id: "import", change: { kind: "import", manifest: "a".repeat(64) } },
    { ...read.operation, maximumBytes: Cloud.chunkBytes + 1 },
    { action: "list", path: "", limit: 129 },
  ])
    expect(Cloud.LocalFileRequest.safeParse({ reference, operation }).success).toBeFalse()
  expect(Cloud.LocalFileRequest.safeParse({ operation: read.operation }).success).toBeFalse()
  expect(Cloud.LocalFileRequest.safeParse({ ...read, reference: { ...reference, revision: 0 } }).success).toBeFalse()
  expect(Cloud.LocalFileRequest.safeParse({ ...read, fallback: "native" }).success).toBeFalse()
  expect(
    Cloud.LocalFileRequest.safeParse({ reference, operation: { action: "list", path: "", cursor: "../outside" } })
      .success,
  ).toBeFalse()
})

test("file signatures bind the complete operation, original reference and accepted root in their own domain", async () => {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const publicKey = await Runtime.publicKey(keys.publicKey)
  const proof = binding()
  const original = Cloud.FileProof.parse({
    purpose: "organization-workspace-file",
    authority: { proof, signature: await Execution.signBinding(proof, keys.privateKey) },
    reference,
    operation: { action: "write", id: "write", path: "a", data: "eA==", expectedVersion: null },
  })
  const signature = await Cloud.signFile(original, keys.privateKey)
  expect(await Cloud.verifyFile(original, signature, publicKey)).toBeTrue()
  for (const change of [
    (p: Cloud.FileProof) => {
      p.reference!.revision++
    },
    (p: Cloud.FileProof) => {
      p.reference!.workspaceID = "other-workspace"
    },
    (p: Cloud.FileProof) => {
      p.reference!.generation++
    },
    (p: Cloud.FileProof) => {
      p.operation = { action: "write", id: "write", path: "b", data: "eQ==", expectedVersion: "another-version" }
    },
    (p: Cloud.FileProof) => {
      p.authority.proof.connectionEpoch++
    },
  ]) {
    const altered = structuredClone(original)
    change(altered)
    expect(await Cloud.verifyFile(altered, signature, publicKey)).toBeFalse()
  }
  expect(
    await Cloud.verifyFile(
      original,
      await signedProtocol(Cloud.FileProof, "different-file-purpose\n").sign(original, keys.privateKey),
      publicKey,
    ),
  ).toBeFalse()
})
