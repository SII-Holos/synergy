import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { OrganizationReadProtocol as Read } from "../src/read"
import { OrganizationReadContent as Content } from "../src/read-content"

function fixture(
  bytes = new TextEncoder().encode(`A${"🙂".repeat(40_000)}Z`),
  original: "complete" | "partial" = "complete",
) {
  const reference = {
    kind: "native" as const,
    version: "part-version-a",
    field: "output" as const,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    original,
  }
  const target = {
    rootSessionID: "session-root",
    sourceSessionID: "session-child",
    messageID: "message-a",
    partID: "part-a",
  }
  const queries: Read.Query[] = []
  const writes: Uint8Array[] = []
  const digest = createHash("sha256")
  const binding = {
    schemaVersion: 1 as const,
    orgID: "org-a",
    projectID: "project-a",
    creatorID: "account-a",
    driverRuntimeID: "runtime-a",
    bindingEpoch: 1,
  }
  const options = {
    ...target,
    reference,
    expectedBinding: binding,
    signal: new AbortController().signal,
    hash: { update: (bytes: Uint8Array) => digest.update(bytes), digest: () => digest.digest("hex") },
    append: async (bytes: Uint8Array) => {
      writes.push(bytes)
    },
    read: async (query: Read.Query): Promise<Read.Result> => {
      queries.push(query)
      if (query.operation !== "partContent") throw new Error("Unexpected operation")
      const data = bytes.subarray(query.offset, Math.min(query.offset + query.length, bytes.byteLength))
      return {
        operation: "partContent",
        state: "ready",
        binding,
        rootSessionID: target.rootSessionID,
        sourceSessionID: target.sourceSessionID,
        value: {
          partID: target.partID,
          messageID: target.messageID,
          version: reference.version,
          part: {
            type: "tool",
            tool: "organization_knowledge",
            callID: "call-a",
            status: "completed",
            startedAt: 1,
            completedAt: 2,
            input: { kind: "inline", text: "{}" },
            output: reference,
          },
        },
        chunk: {
          field: reference.field,
          offset: query.offset,
          nextOffset: query.offset + data.byteLength,
          totalBytes: bytes.byteLength,
          sha256: reference.sha256,
          original: reference.original,
          data: Buffer.from(data).toString("base64url"),
          complete: query.offset + data.byteLength === bytes.byteLength,
        },
      }
    },
  }
  return { options, bytes, queries, writes }
}

test("native fields stream exact UTF-8 bytes in bounded windows with a verified final digest", async () => {
  const f = fixture()
  expect(await Content.stream(f.options)).toEqual({
    state: "ready",
    bytes: f.bytes.byteLength,
    sha256: f.options.reference.sha256,
    original: "complete",
  })
  expect(f.queries.map((query) => (query.operation === "partContent" ? [query.offset, query.length] : []))).toEqual([
    [0, 128 * 1024],
    [128 * 1024, f.bytes.byteLength - 128 * 1024],
  ])
  expect(Buffer.concat(f.writes).equals(Buffer.from(f.bytes))).toBe(true)
})

test("changed versions and response identities never enter the field sink", async () => {
  for (const mutate of [
    (result: Extract<Read.Result, { operation: "partContent"; state: "ready" }>) => {
      result.value.version = "changed"
    },
    (result: Extract<Read.Result, { operation: "partContent"; state: "ready" }>) => {
      result.sourceSessionID = "foreign-session"
    },
    (result: Extract<Read.Result, { operation: "partContent"; state: "ready" }>) => {
      result.binding = { ...result.binding, bindingEpoch: 2 }
    },
  ]) {
    const f = fixture(new Uint8Array([65, 66, 67]))
    const read = f.options.read
    f.options.read = async (query) => {
      const result = await read(query)
      if (result.operation === "partContent" && result.state === "ready") mutate(result)
      return result
    }
    await expect(Content.stream(f.options)).rejects.toMatchObject({ code: "INVALID_RESPONSE" })
    expect(f.writes).toHaveLength(0)
  }
})

test("a non-progressing field window is rejected instead of looping", async () => {
  const f = fixture()
  const read = f.options.read
  f.options.read = async (query) => {
    const result = await read(query)
    if (result.operation === "partContent" && result.state === "ready" && result.chunk) {
      result.chunk.nextOffset = result.chunk.offset
      result.chunk.data = ""
      result.chunk.complete = false
    }
    return result
  }
  await expect(Content.stream(f.options)).rejects.toMatchObject({ code: "INVALID_RESPONSE" })
  expect(f.queries).toHaveLength(1)
})

test("cancellation after one bounded append stops before requesting another field window", async () => {
  const f = fixture()
  const controller = new AbortController()
  f.options.signal = controller.signal
  f.options.append = async (bytes) => {
    f.writes.push(bytes)
    controller.abort()
  }
  await expect(Content.stream(f.options)).rejects.toMatchObject({ name: "AbortError" })
  expect(f.queries).toHaveLength(1)
})

test("field sink backpressure prevents reading ahead and partial originals stay partial at completion", async () => {
  const f = fixture(undefined, "partial")
  const entered = Promise.withResolvers<void>()
  const ready = Promise.withResolvers<void>()
  f.options.append = async (bytes) => {
    f.writes.push(bytes)
    entered.resolve()
    await ready.promise
  }
  const pending = Content.stream(f.options)
  await entered.promise
  expect(f.queries).toHaveLength(1)
  ready.resolve()
  expect(await pending).toMatchObject({ original: "partial", bytes: f.bytes.byteLength })
  expect(f.queries).toHaveLength(2)
})

test("a changed payload digest fails before the caller can publish its staged field", async () => {
  const f = fixture(new Uint8Array([65, 66, 67]))
  const read = f.options.read
  f.options.read = async (query) => {
    const result = await read(query)
    if (result.operation === "partContent" && result.state === "ready" && result.chunk)
      result.chunk.data = Buffer.from([65, 66, 68]).toString("base64url")
    return result
  }
  await expect(Content.stream(f.options)).rejects.toMatchObject({ code: "INVALID_RESPONSE" })
})

test("preparing returns progress and resumes the same version after the verified prefix without hashing twice", async () => {
  const f = fixture()
  const read = f.options.read
  let preparing = true
  let digested = false
  const digest = f.options.hash.digest
  f.options.hash.digest = () => {
    digested = true
    return digest()
  }
  f.options.read = async (query) => {
    if (preparing && query.operation === "partContent" && query.offset > 0)
      return {
        operation: "partContent",
        state: "preparing",
        binding: f.options.expectedBinding,
        rootSessionID: "session-root",
        sourceSessionID: "session-child",
        messageID: "message-a",
        partID: "part-a",
        version: f.options.reference.version,
        progress: { phase: "materializing", bytes: 7, totalBytes: f.bytes.byteLength },
      }
    return read(query)
  }
  const pending = await Content.stream(f.options)
  expect(pending).toMatchObject({
    state: "preparing",
    offset: 128 * 1024,
    pending: { version: "part-version-a", progress: { phase: "materializing", bytes: 7 } },
  })
  expect(digested).toBe(false)
  expect(f.writes).toHaveLength(1)
  if (pending.state !== "preparing") throw new Error("Expected explicit preparation")
  preparing = false
  expect(await Content.stream({ ...f.options, offset: pending.offset })).toMatchObject({
    state: "ready",
    original: "complete",
  })
  expect(Buffer.concat(f.writes).equals(Buffer.from(f.bytes))).toBe(true)
  expect(digested).toBe(true)
})
