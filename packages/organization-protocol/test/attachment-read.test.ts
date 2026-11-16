import { expect, test } from "bun:test"
import { OrganizationReadProtocol as Read } from "../src/read"

const query = {
  operation: "attachmentContent",
  rootSessionID: "root-session",
  sourceSessionID: "child-session",
  messageID: "message-one",
  partID: "part-one",
  version: "part-field:1:fixture",
  offset: 0,
  length: 65_536,
} as const
const binding = {
  schemaVersion: 1,
  orgID: "org-one",
  projectID: "project-one",
  creatorID: "account-one",
  driverRuntimeID: "runtime-one",
  bindingEpoch: 1,
} as const
const reference = {
  kind: "attachment",
  version: query.version,
  filename: "retained.bin",
  mediaType: "application/octet-stream",
  bytes: 3,
  sha256: "a".repeat(64),
} as const
const result = {
  operation: "attachmentContent",
  rootSessionID: query.rootSessionID,
  sourceSessionID: query.sourceSessionID,
  binding,
  messageID: query.messageID,
  partID: query.partID,
  state: "ready",
  reference,
  chunk: { offset: 0, nextOffset: 3, totalBytes: 3, sha256: reference.sha256, data: "AP-A", complete: true },
} as const

test("attachment reads require canonical versioned targets and bounded binary windows without URLs or hashes as authority", () => {
  expect(Read.Query.safeParse(query).success).toBe(true)
  for (const changed of [
    { version: undefined },
    { length: 65_537 },
    { length: 0 },
    { offset: -1 },
    { url: "asset://foreign.bin" },
    { hash: "a".repeat(64) },
  ])
    expect(Read.Query.safeParse({ ...query, ...changed }).success).toBe(false)
  expect(Read.Result.safeParse(result).success).toBe(true)
  expect(Read.Result.safeParse({ ...result, reference: { ...reference, filename: "../../private.bin" } }).success).toBe(
    false,
  )
  expect(Read.Result.safeParse({ ...result, reference: { ...reference, localPath: "/private/file" } }).success).toBe(
    false,
  )
})

test("attachment responses bind exact parts, native versions, complete references and requested byte windows", () => {
  const request = Read.Query.parse(query)
  expect(Read.matches(request, Read.Result.parse(result), binding)).toBe(true)
  for (const changed of [
    { messageID: "another-message" },
    { partID: "another-part" },
    { reference: { ...reference, version: "later-version" } },
    { reference: { ...reference, bytes: 4 } },
    { reference: { ...reference, sha256: "b".repeat(64) } },
    { chunk: { ...result.chunk, offset: 1, nextOffset: 4, totalBytes: 4 } },
  ])
    expect(Read.matches(request, Read.Result.parse({ ...result, ...changed }), binding)).toBe(false)
  const unavailable = {
    operation: "attachmentContent",
    rootSessionID: query.rootSessionID,
    sourceSessionID: query.sourceSessionID,
    binding,
    messageID: query.messageID,
    partID: query.partID,
    version: query.version,
    state: "unavailable",
    reason: "partial",
  }
  expect(Read.matches(request, Read.Result.parse(unavailable), binding)).toBe(true)
  expect(Read.matches(request, Read.Result.parse({ ...unavailable, version: "later-version" }), binding)).toBe(false)
})
