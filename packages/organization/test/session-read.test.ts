import { expect, test } from "bun:test"
import {
  OrganizationReadProtocol as Read,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { commandFixture } from "./support/commands"
import { createSessionReadForwarder } from "../src/session-read"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { OrganizationRecord as Record } from "../src/storage/records"

test("private reads use a finite signed WSS exchange without persisting their body or command receipts", async () => {
  await using f = await commandFixture()
  const socket = await f.connect(1, true, true)
  const reader = createSessionReadForwarder({ connections: f.connections, signing: f.signing, timeoutMs: 2000 })
  const text = "private-original-会話".repeat(4000)
  const bytes = Buffer.from(text)
  const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  const seen = Promise.withResolvers<void>()
  socket.onmessage = async (event) => {
    const frame = Runtime.ServerFrame.parse(JSON.parse(String(event.data)))
    if (frame.type !== "command" || frame.command.kind !== "read") return
    const authorization = frame.command.authorization
    expect(await Read.verify(authorization.permit, authorization.signature, f.signing.identity.publicKey)).toBeTrue()
    expect(authorization.permit.subjectID).toBe("alice")
    const result = Read.Result.parse({
      operation: "partContent",
      rootSessionID: f.sessionID,
      sourceSessionID: f.sessionID,
      binding: Read.bindingFor(authorization.permit),
      value: {
        partID: "part-one",
        messageID: "message-one",
        version: "native-version",
        part: {
          type: "text",
          content: {
            kind: "native",
            version: "native-version",
            field: "text",
            bytes: bytes.length,
            sha256: hash,
            original: "complete",
          },
        },
      },
      chunk: {
        field: "text",
        offset: 0,
        nextOffset: bytes.length,
        totalBytes: bytes.length,
        sha256: hash,
        original: "complete",
        data: bytes.toString("base64url"),
        complete: true,
      },
    })
    socket.send(
      JSON.stringify({
        type: "receipt",
        connectionEpoch: 1,
        exchangeID: frame.exchangeID,
        reply: { kind: "read", authorization, result },
      }),
    )
    seen.resolve()
  }
  const result = await f.run(() =>
    reader.read(f.credentials.alice, {
      operation: "partContent",
      rootSessionID: f.sessionID,
      messageID: "message-one",
      partID: "part-one",
      field: "text",
      length: 128 * 1024,
    }),
  )
  await seen.promise
  expect(result.operation).toBe("partContent")
  if (result.operation !== "partContent" || result.state !== "ready") throw new Error("Expected exact private content")
  expect(Buffer.from(result.chunk!.data, "base64url").toString()).toBe(text)
  await f.run(async () => {
    expect(await Storage.readMany([Keys.commandState(f.sessionID)])).toEqual([undefined])
    expect(await Storage.queryKeys({ prefix: Keys.sharedEvents(f.sessionID, 0), limit: 1 })).toEqual([])
    const rows = await Storage.query({ prefix: ["organization"], limit: 1024 })
    expect(JSON.stringify(rows.map((row) => row.value))).not.toContain("private-original")
  })
})

test("a private response reauthorizes the creator after the Runtime reply", async () => {
  await using f = await commandFixture()
  const socket = await f.connect(1, true, true)
  const reader = createSessionReadForwarder({ connections: f.connections, signing: f.signing, timeoutMs: 2000 })
  const received = Promise.withResolvers<Extract<Runtime.ServerFrame, { type: "command" }>>()
  socket.onmessage = (event) => {
    const frame = Runtime.ServerFrame.parse(JSON.parse(String(event.data)))
    if (frame.type === "command") received.resolve(frame)
  }
  const pending = Promise.resolve(
    f.run(() => reader.read(f.credentials.alice, { operation: "session", rootSessionID: f.sessionID })),
  )
  void pending.catch(() => {})
  const frame = await received.promise
  if (frame.command.kind !== "read") throw new Error("Expected a private read")
  await f.run(async () => {
    const account = (await Record.read(Record.Account, Keys.account("alice")))!
    await Storage.write(Keys.account("alice"), { ...account, authRevision: account.authRevision + 1 })
  })
  socket.send(
    JSON.stringify({
      type: "receipt",
      connectionEpoch: 1,
      exchangeID: frame.exchangeID,
      reply: {
        kind: "read",
        authorization: frame.command.authorization,
        result: {
          operation: "session",
          rootSessionID: f.sessionID,
          sourceSessionID: f.sessionID,
          binding: Read.bindingFor(frame.command.authorization.permit),
          session: { sessionID: f.sessionID, title: "Do not publish", createdAt: 1, updatedAt: 1 },
        },
      },
    }),
  )
  await expect(pending).rejects.toMatchObject({ data: { code: "AUTHENTICATION_REQUIRED" } })
})
