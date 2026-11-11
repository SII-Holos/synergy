import { expect, test } from "bun:test"
import { OrganizationReadProtocol as Read } from "../src/read"
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
})
