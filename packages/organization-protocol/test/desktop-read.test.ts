import { expect, test } from "bun:test"
import { OrganizationDesktop as Desktop } from "../src/desktop"

test("native private reading accepts only the canonical typed query and safe business outcomes", () => {
  const input = {
    requestID: "read-a",
    connectionID: "a".repeat(64),
    query: { rootSessionID: "session-a", operation: "parts", messageID: "message-a", limit: 64 },
  } as const
  expect(Desktop.MemberRequest.parse(input)).toEqual(input)
  expect(
    Desktop.MemberRequest.safeParse({ ...input, query: { ...input.query, directory: "/private/path" } }).success,
  ).toBe(false)
  expect(Desktop.MemberRequest.safeParse({ ...input, url: "http://127.0.0.1/private" }).success).toBe(false)
  expect(Desktop.MemberReadOutcome.parse({ kind: "revision_conflict" })).toEqual({ kind: "revision_conflict" })
  expect(
    Desktop.MemberReadOutcome.safeParse({ kind: "revision_conflict", data: { path: "/private/path", stack: "stack" } })
      .success,
  ).toBe(false)
  const binding = {
    schemaVersion: 1,
    orgID: "org-a",
    projectID: "project-a",
    creatorID: "account-a",
    driverRuntimeID: "runtime-a",
    bindingEpoch: 1,
  } as const
  const value = {
    kind: "result",
    result: {
      operation: "partContent",
      state: "preparing",
      rootSessionID: "session-a",
      sourceSessionID: "session-a",
      binding,
      messageID: "message-a",
      partID: "part-a",
      version: "part-v1",
      progress: { phase: "queued", bytes: 0 },
    },
  } as const
  expect(Desktop.MemberReadOutcome.parse(value)).toEqual(value)
})

test("native content saving binds one immutable field without arbitrary paths or partial starting offsets", () => {
  const input = {
    requestID: "download-a",
    connectionID: "a".repeat(64),
    fileName: "result.txt",
    binding: {
      schemaVersion: 1,
      orgID: "org-a",
      projectID: "project-a",
      creatorID: "account-a",
      driverRuntimeID: "runtime-a",
      bindingEpoch: 1,
    },
    query: {
      operation: "partContent",
      rootSessionID: "session-a",
      messageID: "message-a",
      partID: "part-a",
      field: "output",
      version: "v1",
      offset: 0,
      length: 131072,
    },
    reference: {
      kind: "native",
      version: "v1",
      field: "output",
      bytes: 1,
      sha256: "a".repeat(64),
      original: "partial",
    },
  }
  expect(Desktop.ContentDownload.safeParse(input).success).toBe(true)
  expect(Desktop.ContentDownload.safeParse({ ...input, fileName: "../result.txt" }).success).toBe(false)
  expect(Desktop.ContentDownload.safeParse({ ...input, query: { ...input.query, offset: 1 } }).success).toBe(false)
  expect(Desktop.ContentDownload.safeParse({ ...input, query: { ...input.query, version: "v2" } }).success).toBe(false)
  expect(
    Desktop.ContentDownload.safeParse({ ...input, reference: { ...input.reference, field: "text" } }).success,
  ).toBe(false)
  expect(Desktop.ContentDownload.safeParse({ ...input, directory: "/private/path" }).success).toBe(false)
})
