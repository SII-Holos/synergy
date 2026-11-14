import { expect, spyOn, test } from "bun:test"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { directoryFixture } from "./support/session-directory"
import { OrganizationApiTokens as Tokens } from "../src/auth/api-tokens"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { OrganizationRecord as Record } from "../src/storage/records"
import { OrganizationSessionDirectory as Directory } from "../src/session-directory"
import { commandFixture } from "./support/commands"
import {
  OrganizationRuntimeProtocol as Runtime,
  OrganizationCommandProtocol as Command,
  OrganizationApiTokenProtocol as Protocol,
  OrganizationResourceProtocol as Resource,
} from "@ericsanchezok/synergy-organization-protocol"
import { ApiTokenRecord, apiTokenKeys } from "../src/auth/api-token-record"
import { OrganizationArtifacts as Artifacts } from "../src/artifacts"
import { OrganizationPublications as Publications } from "../src/publications"
import { OrganizationResources as Resources } from "../src/resources"
import { OrganizationPublicationProtocol as Publication } from "@ericsanchezok/synergy-organization-protocol"
import { createHash } from "node:crypto"

const input = () => ({
  requestID: "issue-one",
  projectID: "project",
  label: "External application",
  operations: ["sessions.read" as const],
  expiresAt: Date.now() + 60_000,
})

test("an API token is shown once, survives restart and is fenced by project, operation and current membership", async () => {
  await using f = await directoryFixture()
  await f.run(async () => {
    await Storage.write(Keys.deployment(), {
      schemaVersion: 1,
      orgID: "org",
      deploymentIncarnation: "deployment",
      createdAt: 1,
    })
    await Directory.reservePrivate(f.credentials.alice, {
      sessionID: "one",
      projectID: "project",
      runtimeID: "runtime-alice",
    })
  })
  const request = input()
  const issued = await f.run(() => Tokens.create(f.credentials.alice, request))
  expect(issued.token).toMatch(/^sy_api_[a-f0-9]{64}$/)
  expect(await f.run(() => Tokens.create(f.credentials.alice, request))).toEqual({
    metadata: issued.metadata,
    secretUnavailable: true,
  })
  const headers = { authorization: `Bearer ${issued.token}` }
  const read = () => fetch(new URL("/org/v1/sessions/one", f.baseUrl), { headers })
  expect((await read()).status).toBe(200)
  expect((await fetch(new URL("/org/v1/organization/session-capacity", f.baseUrl), { headers })).status).toBe(403)
  expect((await fetch(new URL("/org/v1/api-tokens", f.baseUrl), { headers })).status).toBe(403)
  await f.restart()
  expect((await read()).status).toBe(200)
  await f.run(async () => {
    const session = (await Record.read(Record.SessionDirectory, Keys.session("one")))!
    const project = (await Record.read(Record.Project, Keys.project("project")))!
    await Storage.write(Keys.project("other"), { ...project, projectID: "other" })
    await Storage.write(Keys.session("one"), { ...session, projectID: "other" })
  })
  expect((await read()).status).toBe(404)
  await f.run(async () => {
    const session = (await Record.read(Record.SessionDirectory, Keys.session("one")))!
    await Storage.write(Keys.session("one"), { ...session, projectID: "project" })
    await Storage.remove(Keys.projectMember("project", "alice"))
  })
  expect((await read()).status).toBe(404)
})

test("API token revocation, expiry and auth revision fence future reads without storing the original secret", async () => {
  await using f = await directoryFixture()
  await f.run(() =>
    Storage.write(Keys.deployment(), {
      schemaVersion: 1,
      orgID: "org",
      deploymentIncarnation: "deployment",
      createdAt: 1,
    }),
  )
  const issued = await f.run(() => Tokens.create(f.credentials.alice, input()))
  const listed = await f.run(() => Tokens.list(f.credentials.alice, {}))
  expect(listed.items).toEqual([issued.metadata])
  expect(JSON.stringify(listed)).not.toContain(issued.token!)
  await f.run(async () => {
    for (const entry of await Storage.query({ prefix: ["organization-api-tokens"], limit: 100 })) {
      expect(JSON.stringify(entry.value)).not.toContain(issued.token!)
    }
  })
  await f.run(() => Tokens.revoke(f.credentials.alice, issued.metadata.tokenID, { expectedRevision: 1 }))
  const headers = { authorization: `Bearer ${issued.token}` }
  expect((await fetch(new URL("/org/v1/projects/project/sessions", f.baseUrl), { headers })).status).toBe(401)
  await expect(
    f.run(() =>
      Tokens.create(f.credentials.reader, { ...input(), requestID: "reader-write", operations: ["sessions.create"] }),
    ),
  ).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
  await expect(
    f.run(() => Tokens.create(f.credentials.alice, { ...input(), requestID: "expired", expiresAt: 1 })),
  ).rejects.toMatchObject({ data: { code: "INVALID_REQUEST" } })
  const second = await f.run(() => Tokens.create(f.credentials.alice, { ...input(), requestID: "second" }))
  await f.run(async () => {
    const account = (await Record.read(Record.Account, Keys.account("alice")))!
    await Storage.write(Keys.account("alice"), { ...account, authRevision: account.authRevision + 1 })
  })
  expect(
    (
      await fetch(new URL("/org/v1/projects/project/sessions", f.baseUrl), {
        headers: { authorization: `Bearer ${second.token}` },
      })
    ).status,
  ).toBe(401)
})

test("external bearer commands preserve signed token attribution, exact retries and offline refusal", async () => {
  await using f = await commandFixture()
  const issued = await f.run(() =>
    Tokens.create(f.credentials.alice, {
      ...input(),
      operations: ["sessions.input", "sessions.read", "sessions.cancel"],
      expiresAt: Date.now() + 5_000,
    }),
  )
  const socket = await f.connect()
  let inputs = 0
  let saved: Command.Result | undefined
  let authorization: Command.SignedPermit | undefined
  socket.onmessage = (event) => {
    const frame = Runtime.ServerFrame.parse(JSON.parse(String(event.data)))
    if (frame.type !== "command") return
    if (frame.command.kind === "input") {
      inputs++
      authorization = frame.command.delivery.authorization
      const permit = authorization.permit
      saved = Command.Result.parse({
        attempt: {
          schemaVersion: 1,
          permit,
          receivedAt: Date.now(),
          status: "accepted",
          acceptedAttemptID: permit.attemptID,
        },
        accepted: {
          schemaVersion: 1,
          permit,
          acceptedAt: Date.now(),
          intakeSeq: permit.commandSeq,
          effect: { kind: "inbox", itemID: "one-item", messageID: "one-message", mode: "context" },
        },
      })
    }
    socket.send(
      JSON.stringify({
        type: "receipt",
        connectionEpoch: frame.connectionEpoch,
        exchangeID: frame.exchangeID,
        reply: { kind: "result", result: saved },
      }),
    )
  }
  const headers = { authorization: `Bearer ${issued.token}`, "content-type": "application/json" }
  const request = f.request()
  const send = (value = request) =>
    fetch(new URL(`/org/v1/sessions/${f.sessionID}/commands`, f.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(value),
    })
  const response = await send()
  expect(response.status).toBe(202)
  const received = Command.InputAccepted.parse(await response.json())
  expect(received.permit.actor).toMatchObject({
    subjectID: "alice",
    clientKind: "api",
    tokenID: issued.metadata.tokenID,
  })
  expect(received.permit.deadline).toBeLessThanOrEqual(issued.metadata.expiresAt)
  if (!authorization) throw new Error("Expected a signed command")
  expect(await Command.verify(received.permit, authorization.signature, f.signing.identity.publicKey)).toBe(true)
  expect(
    await Command.verify(
      { ...received.permit, actor: { ...received.permit.actor, tokenID: "forged" } },
      authorization.signature,
      f.signing.identity.publicKey,
    ),
  ).toBe(false)
  expect((await send()).status).toBe(200)
  expect(inputs).toBe(1)
  expect((await send(f.request("request", "changed"))).status).toBe(409)
  expect((await fetch(new URL(`/org/v1/commands/request`, f.baseUrl), { headers })).status).toBe(200)
  const readOnly = await f.run(() => Tokens.create(f.credentials.alice, { ...input(), requestID: "read-only" }))
  expect(
    (
      await fetch(new URL(`/org/v1/sessions/${f.sessionID}/commands`, f.baseUrl), {
        method: "POST",
        headers: { ...headers, authorization: `Bearer ${readOnly.token}` },
        body: JSON.stringify(f.request("forbidden")),
      })
    ).status,
  ).toBe(403)
  f.connections.close()
  expect((await send(f.request("offline"))).status).toBe(503)
  expect(inputs).toBe(1)
  await f.run(() => Tokens.revoke(f.credentials.alice, issued.metadata.tokenID, { expectedRevision: 1 }))
  expect((await fetch(new URL(`/org/v1/commands/request`, f.baseUrl), { headers })).status).toBe(401)
})

test("expiry fences the API token alone while deployment replacement fences all credentials", async () => {
  await using f = await directoryFixture()
  await f.run(() =>
    Storage.write(Keys.deployment(), {
      schemaVersion: 1,
      orgID: "org",
      deploymentIncarnation: "deployment",
      createdAt: 1,
    }),
  )
  const issued = await f.run(() => Tokens.create(f.credentials.alice, input()))
  await f.run(async () => {
    const stored = ApiTokenRecord.parse(await Storage.read(apiTokenKeys.record(issued.metadata.tokenID)))
    await Storage.write(apiTokenKeys.record(stored.tokenID), { ...stored, expiresAt: 1 })
  })
  const list = (token: string) =>
    fetch(new URL("/org/v1/projects/project/sessions", f.baseUrl), { headers: { authorization: `Bearer ${token}` } })
  expect((await list(issued.token!)).status).toBe(401)
  expect((await f.request("alice", "/projects/project/sessions")).status).toBe(200)
  const second = await f.run(() => Tokens.create(f.credentials.alice, { ...input(), requestID: "new" }))
  await f.run(() =>
    Storage.write(Keys.deployment(), {
      schemaVersion: 1,
      orgID: "org",
      deploymentIncarnation: "new-deployment",
      createdAt: 1,
    }),
  )
  expect((await list(second.token!)).status).toBe(401)
  expect((await f.request("alice", "/projects/project/sessions")).status).toBe(401)
  expect(Protocol.Create.safeParse({ ...input(), operations: ["sessions.read", "sessions.read"] }).success).toBe(false)
})

test("API token HTTP issuance is personal and its resource capability never becomes administrative access", async () => {
  await using f = await commandFixture()
  const issue = async (value = { ...input(), operations: ["resources.read", "sessions.configure", "sessions.read"] }) =>
    fetch(new URL("/org/v1/api-tokens", f.baseUrl), {
      method: "POST",
      headers: { ...f.apiHeaders(), "content-type": "application/json" },
      body: JSON.stringify(value),
    })
  const request = { ...input(), operations: ["resources.read", "sessions.configure", "sessions.read"] }
  const first = await issue(request)
  expect(first.status).toBe(200)
  const created = Protocol.Created.parse(await first.json())
  const retry = await issue(request)
  expect(Protocol.Created.parse(await retry.json())).toEqual({ metadata: created.metadata, secretUnavailable: true })
  const resource = await f.run(async () => {
    const resource = await Resources.create(
      f.credentials.admin,
      Resource.Create.parse({
        name: "Shared model",
        scope: { kind: "project", projectID: "project" },
        configuration: {
          protocol: "openai-compatible",
          endpoint: "https://models.example/v1",
          model: { id: "test-model", name: "Test", limit: { context: 32000, output: 2000 } },
        },
        credential: { kind: "bearer", value: "fixture-private-resource-credential" },
      }),
    )
    await Resources.grant(
      f.credentials.admin,
      resource.resourceID,
      { kind: "project", id: "project" },
      { expectedRevision: 0, enabled: true },
    )
    return resource
  })
  const headers = { authorization: `Bearer ${created.token}`, "content-type": "application/json" }
  const available = await fetch(new URL("/org/v1/projects/project/resources", f.baseUrl), { headers })
  expect(available.status).toBe(200)
  const body = await available.json()
  expect(JSON.stringify(body)).not.toContain("fixture-private-resource-credential")
  expect(JSON.stringify(body)).not.toContain("configuration")
  expect((await fetch(new URL(`/org/v1/resources/${resource.resourceID}`, f.baseUrl), { headers })).status).toBe(403)
  const select = () =>
    fetch(new URL(`/org/v1/sessions/${f.sessionID}/resources`, f.baseUrl), {
      method: "PUT",
      headers,
      body: JSON.stringify({
        expectedRevision: 0,
        selection: {
          modelResourceID: resource.resourceID,
          connectionResourceIDs: [],
          infrastructure: { workspace: null, environment: null },
        },
      }),
    })
  expect((await select()).status).toBe(200)
  await f.run(() =>
    Resources.grant(
      f.credentials.admin,
      resource.resourceID,
      { kind: "project", id: "project" },
      { expectedRevision: 1, enabled: false },
    ),
  )
  expect(
    (
      await fetch(new URL(`/org/v1/sessions/${f.sessionID}/resources`, f.baseUrl), {
        method: "PUT",
        headers,
        body: JSON.stringify({
          expectedRevision: 1,
          selection: {
            modelResourceID: resource.resourceID,
            connectionResourceIDs: [],
            infrastructure: { workspace: null, environment: null },
          },
        }),
      })
    ).status,
  ).toBe(404)
  expect(
    (
      await fetch(new URL(`/org/v1/api-tokens/${created.metadata.tokenID}/revoke`, f.baseUrl), {
        method: "POST",
        headers: { ...f.apiHeaders("bob"), "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: 1 }),
      })
    ).status,
  ).toBe(404)
})

test("artifact-only API tokens read retained Range bytes and revocation interrupts their ongoing stream", async () => {
  await using f = await commandFixture()
  const bytes = new Uint8Array(Publication.chunkBytes * 3 + 1).fill(71)
  const staged = await f.run(async () => {
    const upload = await Publications.create(f.credentials.alice, {
      requestID: "artifact-upload",
      purpose: "artifact",
      scope: { kind: "project", projectID: "project" },
      sourceSessionID: f.sessionID,
    })
    const file = await Publications.putFile(f.credentials.alice, upload.uploadID, {
      path: "result.bin",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mediaType: "application/octet-stream",
    })
    for (let offset = 0; offset < bytes.length; offset += Publication.chunkBytes)
      await Publications.putChunk(
        f.credentials.alice,
        upload.uploadID,
        file.fileID,
        offset,
        bytes.subarray(offset, offset + Publication.chunkBytes),
      )
    await Publications.seal(f.credentials.alice, upload.uploadID, { fileCount: 1, totalBytes: bytes.length })
    await Artifacts.publish(f.credentials.alice, {
      requestID: "publish",
      artifactID: "result",
      expectedRevision: 0,
      uploadID: upload.uploadID,
      title: "Result",
    })
    return file
  })
  const issued = await f.run(() => Tokens.create(f.credentials.reader, { ...input(), operations: ["artifacts.read"] }))
  const credentials = { token: issued.token!, kind: "api" as const, apiOperation: "artifacts.read" as const }
  const headers = { authorization: `Bearer ${issued.token}` }
  const url = new URL(`/org/v1/artifacts/result/versions/1/files/${staged.fileID}/content`, f.baseUrl)
  const range = await fetch(url, { headers: { ...headers, range: "bytes=2-5" } })
  expect(range.status).toBe(206)
  expect(new Uint8Array(await range.arrayBuffer())).toEqual(bytes.slice(2, 6))
  expect((await fetch(new URL(`/org/v1/sessions/${f.sessionID}`, f.baseUrl), { headers })).status).toBe(403)
  const response = await f.run(() => Artifacts.content(credentials, "result", 1, staged.fileID))
  const reader = response.body!.getReader()
  let received = (await reader.read()).value!.length
  await f.run(() => Tokens.revoke(f.credentials.reader, issued.metadata.tokenID, { expectedRevision: 1 }))
  await expect(
    (async () => {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        received += chunk.value.length
      }
    })(),
  ).rejects.toThrow()
  expect(received).toBeLessThan(bytes.length)
})

test("committed issuance with a lost acknowledgement can be inspected and revoked without redisclosing a secret", async () => {
  await using f = await commandFixture()
  const request = input()
  const transaction = Storage.transaction
  let dropped = false
  const fault = spyOn(Storage, "transaction").mockImplementation(
    async <T>(
      body: Parameters<typeof Storage.transaction<T>>[0],
      options?: Parameters<typeof Storage.transaction<T>>[1],
    ): Promise<T> => {
      const result = await transaction(body, options)
      if (!dropped && !Storage.inTransaction()) {
        dropped = true
        throw new Error("Synthetic issuance acknowledgement loss after SQL commit")
      }
      return result
    },
  )
  try {
    await expect(f.run(() => Tokens.create(f.credentials.alice, request))).rejects.toThrow("after SQL commit")
  } finally {
    fault.mockRestore()
  }
  expect(dropped).toBe(true)
  const receipt = await f.run(() => Tokens.create(f.credentials.alice, request))
  expect(receipt.token).toBeUndefined()
  expect(receipt.secretUnavailable).toBe(true)
  expect((await f.run(() => Tokens.list(f.credentials.alice, {}))).items).toEqual([receipt.metadata])
  const revoked = await f.run(() =>
    Tokens.revoke(f.credentials.alice, receipt.metadata.tokenID, { expectedRevision: 1 }),
  )
  expect(revoked.revokedAt).toBeDefined()
  expect(
    await f.run(() => Tokens.revoke(f.credentials.alice, receipt.metadata.tokenID, { expectedRevision: 1 })),
  ).toEqual(revoked)
})
