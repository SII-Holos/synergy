import { expect, test } from "bun:test"
import { OrganizationReadProtocol as Read } from "../src/read"
import { OrganizationReadContent } from "../src/read-content"

const content = Uint8Array.from({ length: 150_001 }, (_, index) => index % 256)
const digest = new Bun.CryptoHasher("sha256").update(content).digest("hex")
const binding = {
  schemaVersion: 1,
  orgID: "org-one",
  projectID: "project-one",
  creatorID: "account-one",
  driverRuntimeID: "runtime-one",
  bindingEpoch: 1,
} as const
const reference: Read.AttachmentReference = {
  kind: "attachment",
  version: "attachment-v1",
  filename: "retained.bin",
  mediaType: "application/octet-stream",
  bytes: content.length,
  sha256: digest,
}
function response(query: Read.Query): Read.Result {
  if (query.operation !== "attachmentContent") throw new Error("Expected an attachment request")
  const data = content.subarray(query.offset, query.offset + query.length)
  return {
    operation: "attachmentContent",
    rootSessionID: query.rootSessionID,
    sourceSessionID: query.sourceSessionID ?? query.rootSessionID,
    messageID: query.messageID,
    partID: query.partID,
    ...(query.ordinal !== undefined ? { ordinal: query.ordinal } : {}),
    binding,
    state: "ready",
    reference,
    chunk: {
      offset: query.offset,
      nextOffset: query.offset + data.length,
      totalBytes: content.length,
      sha256: digest,
      data: Buffer.from(data).toString("base64url"),
      complete: query.offset + data.length === content.length,
    },
  }
}
const target = {
  rootSessionID: "session-one",
  sourceSessionID: "child-one",
  messageID: "message-one",
  partID: "part-one",
  reference,
  expectedBinding: binding,
}

test("attachment streaming verifies binary bytes and awaits sink backpressure before another bounded read", async () => {
  const controller = new AbortController()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const chunks: Uint8Array[] = []
  const queries: Read.Query[] = []
  const hash = new Bun.CryptoHasher("sha256")
  const pending = OrganizationReadContent.stream({
    ...target,
    signal: controller.signal,
    read: async (query) => {
      queries.push(query)
      return response(query)
    },
    append: async (data) => {
      chunks.push(data)
      if (chunks.length === 1) {
        entered.resolve()
        await release.promise
      }
    },
    hash: { update: (bytes) => hash.update(bytes), digest: () => hash.digest("hex") },
  })
  void pending.catch(() => entered.resolve())
  try {
    await entered.promise
    expect(queries).toHaveLength(1)
  } finally {
    release.resolve()
  }
  expect(await pending).toEqual({ state: "ready", bytes: content.length, sha256: digest, original: "complete" })
  expect(Buffer.concat(chunks)).toEqual(Buffer.from(content))
  expect(
    queries.every(
      (query) =>
        query.operation === "attachmentContent" && query.version === reference.version && query.length <= 65_536,
    ),
  ).toBe(true)
})

test("unavailable attachment evidence after a prefix never finalizes the digest", async () => {
  let appended = 0
  let digests = 0
  const result = await OrganizationReadContent.stream({
    ...target,
    signal: new AbortController().signal,
    read: async (query) => {
      if (query.operation !== "attachmentContent") throw new Error("Expected an attachment request")
      return query.offset
        ? {
            operation: "attachmentContent",
            rootSessionID: query.rootSessionID,
            sourceSessionID: query.sourceSessionID ?? query.rootSessionID,
            messageID: query.messageID,
            partID: query.partID,
            binding,
            state: "unavailable",
            version: reference.version,
            reason: "not_retained",
          }
        : response(query)
    },
    append: async (bytes) => {
      appended += bytes.length
    },
    hash: {
      update() {},
      digest() {
        digests++
        return digest
      },
    },
  })
  expect(result).toMatchObject({ state: "unavailable", offset: 65_536, pending: { reason: "not_retained" } })
  expect(appended).toBe(65_536)
  expect(digests).toBe(0)
})

test("changed attachment metadata and invalid binary bytes cannot become a verified saved result", async () => {
  let appended = 0
  await expect(
    OrganizationReadContent.stream({
      ...target,
      signal: new AbortController().signal,
      read: async (query) => {
        const value = response(query)
        if (value.operation !== "attachmentContent" || value.state !== "ready")
          throw new Error("Expected attachment bytes")
        return { ...value, reference: { ...reference, filename: "another.bin" } }
      },
      append: async () => {
        appended++
      },
      hash: { update() {}, digest: () => digest },
    }),
  ).rejects.toThrow()
  expect(appended).toBe(0)
  const hash = new Bun.CryptoHasher("sha256")
  await expect(
    OrganizationReadContent.stream({
      ...target,
      signal: new AbortController().signal,
      read: async (query) => {
        const value = response(query)
        if (value.operation !== "attachmentContent" || value.state !== "ready")
          throw new Error("Expected attachment bytes")
        return {
          ...value,
          chunk: {
            ...value.chunk,
            data: Buffer.alloc(value.chunk.nextOffset - value.chunk.offset).toString("base64url"),
          },
        }
      },
      append: async () => {},
      hash: { update: (bytes) => hash.update(bytes), digest: () => hash.digest("hex") },
    }),
  ).rejects.toThrow()
})

test("tool attachment streams retain one ordinal on every chunk and reject another slot before appending", async () => {
  const queries: Read.Query[] = []
  const hash = new Bun.CryptoHasher("sha256")
  expect(
    await OrganizationReadContent.stream({
      ...target,
      ordinal: 1000,
      signal: new AbortController().signal,
      read: async (query) => {
        queries.push(query)
        return response(query)
      },
      append: async () => {},
      hash: { update: (bytes) => hash.update(bytes), digest: () => hash.digest("hex") },
    }),
  ).toMatchObject({ state: "ready", bytes: content.length })
  expect(queries).toHaveLength(3)
  expect(queries.every((query) => query.operation === "attachmentContent" && query.ordinal === 1000)).toBe(true)
  let appends = 0
  await expect(
    OrganizationReadContent.stream({
      ...target,
      ordinal: 1000,
      signal: new AbortController().signal,
      read: async (query) => ({ ...response(query), ordinal: 999 }),
      append: async () => {
        appends++
      },
      hash: { update() {}, digest: () => digest },
    }),
  ).rejects.toThrow()
  expect(appends).toBe(0)
})
