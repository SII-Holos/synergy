import { expect, test } from "bun:test"
import { OrganizationDesktop as Desktop } from "../src/desktop"

const binding = { schemaVersion: 1, orgID: "org", projectID: "project", creatorID: "creator", driverRuntimeID: "runtime", bindingEpoch: 1 } as const
const input = {
  requestID: "save-attachment", connectionID: "a".repeat(64), binding,
  query: { operation: "attachmentContent", rootSessionID: "root", sourceSessionID: "child", messageID: "message", partID: "part", version: "part-v1", offset: 0, length: 65_536 },
} as const

test("native attachment saving accepts only an exact versioned Session target", () => {
  expect(Desktop.AttachmentDownload.parse(input)).toEqual(input)
  for (const extra of [{ url: "asset://hash" }, { path: "/private/file" }, { sha256: "a".repeat(64) }, { fileName: "injected.txt" }])
    expect(Desktop.AttachmentDownload.safeParse({ ...input, ...extra }).success).toBe(false)
  expect(Desktop.AttachmentDownload.safeParse({ ...input, query: { ...input.query, offset: 1 } }).success).toBe(false)
  expect(Desktop.AttachmentDownload.safeParse({ ...input, query: { ...input.query, length: 65_537 } }).success).toBe(false)
  expect(Desktop.AttachmentDownload.safeParse({ ...input, query: { operation: "status", rootSessionID: "root" } }).success).toBe(false)
  expect(Desktop.AttachmentDownload.safeParse({ ...input, query: { ...input.query, version: undefined } }).success).toBe(false)
})

test("attachment download outcomes retain unavailable evidence without native locations", () => {
  expect(Desktop.AttachmentDownloadOutcome.parse({ kind: "unavailable", version: "part-v1", reason: "partial" })).toEqual({ kind: "unavailable", version: "part-v1", reason: "partial" })
  expect(Desktop.AttachmentDownloadOutcome.safeParse({ kind: "unavailable", version: "part-v1", reason: "partial", path: "/private/file" }).success).toBe(false)
})
