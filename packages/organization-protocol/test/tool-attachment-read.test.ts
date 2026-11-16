import { expect, test } from "bun:test"
import { OrganizationReadProtocol as Read } from "../src/read"

const binding = {
  schemaVersion: 1,
  orgID: "org",
  projectID: "project",
  creatorID: "creator",
  driverRuntimeID: "runtime",
  bindingEpoch: 1,
} as const
const target = { rootSessionID: "root", sourceSessionID: "child", messageID: "message", partID: "tool" }
const item = { ordinal: 1000, filename: "evidence.bin", mediaType: "application/octet-stream", bytes: 3 }

test("tool attachment metadata uses finite exact-producer pages without reference URLs or full arrays", () => {
  const summary = {
    partID: "tool",
    messageID: "message",
    type: "tool",
    preview: "fixture",
    content: { version: "display-v1", bytes: 0 },
    attachmentCount: 0,
  }
  expect(Read.PartSummary.safeParse(summary).success).toBe(true)
  expect(Read.PartSummary.safeParse({ ...summary, attachmentCount: -1 }).success).toBe(false)
  const query = Read.Query.parse({ ...target, operation: "attachments", limit: 32 })
  const result = Read.Result.parse({
    ...target,
    operation: "attachments",
    binding,
    version: "part-attachments:1:3",
    items: [item],
    total: 1001,
    cursor: "next",
  })
  expect(Read.matches(query, result, binding)).toBe(true)
  expect(Read.Query.safeParse({ ...target, operation: "attachments", limit: 33 }).success).toBe(false)
  expect(Read.Result.safeParse({ ...result, items: [{ ...item, url: "asset://hash" }] }).success).toBe(false)
  expect(
    Read.Result.safeParse({ ...result, items: Array.from({ length: 33 }, (_, ordinal) => ({ ...item, ordinal })) })
      .success,
  ).toBe(false)
  expect(Read.matches(query, Read.Result.parse({ ...result, partID: "other-tool" }), binding)).toBe(false)
  expect(Read.matches(query, Read.Result.parse({ ...result, items: [item, item] }), binding)).toBe(false)
})

test("ordinal byte responses bind the exact tool slot while standalone attachments keep their original shape", () => {
  const query = Read.Query.parse({
    ...target,
    operation: "attachmentContent",
    version: "part-attachments:1:3",
    ordinal: 1000,
    offset: 0,
    length: 65536,
  })
  const reference = {
    kind: "attachment",
    version: "part-attachments:1:3",
    filename: item.filename,
    mediaType: item.mediaType,
    bytes: 3,
    sha256: "a".repeat(64),
  }
  const result = Read.Result.parse({
    ...target,
    operation: "attachmentContent",
    binding,
    ordinal: 1000,
    state: "ready",
    reference,
    chunk: { offset: 0, nextOffset: 3, totalBytes: 3, sha256: reference.sha256, data: "AP-A", complete: true },
  })
  expect(Read.matches(query, result, binding)).toBe(true)
  expect(Read.matches(query, Read.Result.parse({ ...result, ordinal: 0 }), binding)).toBe(false)
  expect(Read.matches(query, Read.Result.parse({ ...result, ordinal: undefined }), binding)).toBe(false)
  const unavailable = Read.Result.parse({
    ...target,
    operation: "attachmentContent",
    binding,
    ordinal: 1000,
    state: "unavailable",
    version: query.operation === "attachmentContent" ? query.version : "",
    reason: "partial",
  })
  expect(Read.matches(query, unavailable, binding)).toBe(true)
  expect(Read.matches(query, Read.Result.parse({ ...unavailable, ordinal: 999 }), binding)).toBe(false)
  expect(Read.Query.safeParse({ ...query, ordinal: -1 }).success).toBe(false)
  expect(Read.Query.safeParse({ ...query, ordinal: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false)
})

test("private read signatures bind tool attachment ordinal and producer version", async () => {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const permit = Read.Permit.parse({
    purpose: "session-read",
    schemaVersion: 1,
    orgID: "org",
    deploymentIncarnation: "deployment",
    runtimeID: "runtime",
    projectID: "project",
    creatorID: "creator",
    subjectID: "creator",
    keyID: "key",
    bindingEpoch: 1,
    connectionEpoch: 1,
    issuedAt: 1000,
    expiresAt: 2000,
    query: { ...target, operation: "attachmentContent", version: "part-attachments:1:3", ordinal: 1000 },
  })
  const signature = await Read.sign(permit, keys.privateKey)
  const publicKey = await Read.publicKey(keys.publicKey)
  expect(await Read.verify(permit, signature, publicKey)).toBe(true)
  expect(await Read.verify({ ...permit, query: { ...permit.query, ordinal: 999 } }, signature, publicKey)).toBe(false)
  expect(
    await Read.verify({ ...permit, query: { ...permit.query, version: "part-attachments:1:4" } }, signature, publicKey),
  ).toBe(false)
})
