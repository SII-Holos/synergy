import { expect, test } from "bun:test"
import { OrganizationReadProtocol as Read } from "../src/read"

test("private task pages bind every visible child to the selected native parent without payload fields", () => {
  const query = Read.Query.parse({ operation: "tasks", rootSessionID: "root", sourceSessionID: "parent", limit: 2 })
  const binding = { schemaVersion: 1 as const, orgID: "org", projectID: "project", creatorID: "creator", driverRuntimeID: "runtime", bindingEpoch: 1 }
  const item = { sessionID: "child", taskID: "task", parentSessionID: "parent", parentMessageID: "message", status: "completed", description: "Task description", startedAt: 1 }
  const result = Read.Result.parse({ operation: "tasks", rootSessionID: "root", sourceSessionID: "parent", binding, items: [item], total: 1 })
  expect(Read.matches(query, result, binding)).toBeTrue()
  expect(Read.matches(query, { ...result, items: [{ ...item, parentSessionID: "foreign" }] } as typeof result, binding)).toBeFalse()
  expect(Read.Result.safeParse({ ...result, items: [{ ...item, prompt: "private prompt" }] }).success).toBeFalse()
  expect(Read.Query.safeParse({ operation: "tasks", rootSessionID: "root", limit: 65 }).success).toBeFalse()
})

test("private reads select fixed session operations and bounded content windows", () => {
  expect(Read.Query.parse({ operation: "timeline", rootSessionID: "session-one" })).toMatchObject({
    operation: "timeline",
    limit: 32,
  })
  expect(
    Read.Query.parse({
      operation: "partContent",
      rootSessionID: "session-one",
      messageID: "message-one",
      partID: "part-one",
      offset: 12,
      length: 131072,
    }),
  ).toMatchObject({ offset: 12, length: 131072 })
  for (const input of [
    { operation: "timeline", rootSessionID: "session-one", limit: 65 },
    { operation: "parts", rootSessionID: "session-one", messageID: "message-one", limit: 129 },
    {
      operation: "partContent",
      rootSessionID: "session-one",
      messageID: "message-one",
      partID: "part-one",
      offset: -1,
    },
    {
      operation: "partContent",
      rootSessionID: "session-one",
      messageID: "message-one",
      partID: "part-one",
      length: 131073,
    },
    { operation: "session", rootSessionID: "session-one", directory: "/arbitrary/path" },
    { operation: "session", rootSessionID: "session-one", scopeID: "untrusted-scope" },
    { operation: "fetch", rootSessionID: "session-one", path: "/global/config" },
  ])
    expect(Read.Query.safeParse(input).success).toBe(false)
})

test("private read authority binds its full query, execution binding and finite signing window", async () => {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const permit = Read.Permit.parse({
    purpose: "session-read",
    schemaVersion: 1,
    orgID: "organization-one",
    deploymentIncarnation: "deployment-one",
    runtimeID: "runtime-one",
    projectID: "project-one",
    creatorID: "creator-one",
    subjectID: "reader-one",
    keyID: "key-one",
    bindingEpoch: 2,
    connectionEpoch: 3,
    query: { operation: "timeline", rootSessionID: "session-one" },
    issuedAt: 1000,
    expiresAt: 2000,
  })
  const signature = await Read.sign(permit, keys.privateKey)
  const publicKey = await Read.publicKey(keys.publicKey)
  expect(await Read.verify(permit, signature, publicKey)).toBeTrue()
  for (const changed of [
    { ...permit, purpose: "runtime-connect" },
    { ...permit, bindingEpoch: 3 },
    { ...permit, subjectID: "other-reader" },
    { ...permit, query: { ...permit.query, sourceSessionID: "other-session" } },
  ])
    expect(await Read.verify(changed, signature, publicKey)).toBeFalse()
  expect(Read.Permit.safeParse({ ...permit, expiresAt: 999 }).success).toBeFalse()
  expect(Read.Permit.safeParse({ ...permit, expiresAt: 32_001 }).success).toBeFalse()
})

test("native content references describe exact fields without paths or shared blob identities", () => {
  const reference = {
    kind: "native",
    version: "part-version",
    field: "text",
    bytes: 20,
    sha256: "a".repeat(64),
    original: "complete",
  } as const
  expect(Read.Content.parse(reference)).toEqual(reference)
  for (const changed of [
    { ...reference, directory: "/private/root" },
    { ...reference, blobID: "invented-shared-blob" },
    { ...reference, bytes: -1 },
    { ...reference, field: "credentials" },
  ])
    expect(Read.Content.safeParse(changed).success).toBeFalse()
  expect(
    Read.Part.parse({
      partID: "part-one",
      messageID: "message-one",
      version: "part-version",
      part: { type: "text", content: reference },
    }).part.type,
  ).toBe("text")
  expect(Read.Content.parse({ ...reference, original: "partial" })).toMatchObject({ original: "partial" })
  expect(Read.Content.safeParse({ ...reference, original: undefined }).success).toBeFalse()
})

test("native field preparation reports real progress without inventing body metadata", () => {
  const query = Read.Query.parse({
    operation: "partContent",
    rootSessionID: "root",
    messageID: "message",
    partID: "part",
    version: "native-version",
  })
  const binding = {
    schemaVersion: 1 as const,
    orgID: "org",
    projectID: "project",
    creatorID: "creator",
    driverRuntimeID: "runtime",
    bindingEpoch: 1,
  }
  const result = Read.Result.parse({
    operation: "partContent",
    rootSessionID: "root",
    sourceSessionID: "root",
    binding,
    state: "preparing",
    messageID: "message",
    partID: "part",
    version: "native-version",
    progress: { phase: "materializing", bytes: 1024 },
  })
  expect(Read.matches(query, result)).toBeTrue()
  if (result.operation !== "partContent" || result.state !== "preparing")
    throw new Error("Expected preparation progress")
  expect(Read.matches(query, { ...result, partID: "other-part" })).toBeFalse()
  expect(Read.Result.safeParse({ ...result, value: {} }).success).toBeFalse()
  expect(Read.matches(query, result, { ...binding, bindingEpoch: 2 })).toBeFalse()
})
