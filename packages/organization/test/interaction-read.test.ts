import { expect, test } from "bun:test"
import {
  OrganizationInteractionProtocol as Protocol,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationRecord as Record } from "../src/storage/records"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { createSessionReadForwarder } from "../src/session-read"
import { commandFixture } from "./support/commands"

type Frame = Extract<Runtime.ServerFrame, { type: "command" }>
function answer(socket: WebSocket, frame: Frame) {
  if (frame.command.kind !== "interactions") throw new Error("Expected interaction query")
  const { authorization } = frame.command
  const query = authorization.permit.query
  const result = Protocol.Result.parse({
    operation: "pending",
    rootSessionID: query.rootSessionID,
    sourceSessionID: query.sourceSessionID ?? query.rootSessionID,
    binding: authorization.permit.binding,
    runtimeKind: "member",
    items: [
      {
        kind: "question",
        requestID: "question-pending",
        sourceSessionID: query.rootSessionID,
        questions: [{ question: "private pending prompt fixture", header: "Fixture", options: [] }],
      },
    ],
    hasMore: false,
  })
  socket.send(
    JSON.stringify({
      type: "receipt",
      connectionEpoch: frame.connectionEpoch,
      exchangeID: frame.exchangeID,
      reply: { kind: "interactions", authorization, result },
    }),
  )
}

test("safe transient queries permit shared readers without extending creator-only private body access or persisting confirmation content", async () => {
  await using f = await commandFixture()
  const socket = await f.connect(1, true, false, true)
  let subject: string | undefined
  socket.onmessage = (event) => {
    const frame = Runtime.ServerFrame.parse(JSON.parse(String(event.data)))
    if (frame.type !== "command" || frame.command.kind !== "interactions") return
    subject = frame.command.authorization.permit.subjectID
    answer(socket, frame)
  }
  const reads = createSessionReadForwarder({ connections: f.connections, signing: f.signing })
  await f.run(async () => {
    const query = Protocol.Query.parse({ operation: "pending", rootSessionID: f.sessionID, limit: 1 })
    await expect(reads.interactions(f.credentials.admin, query)).rejects.toMatchObject({ data: { code: "NOT_FOUND" } })
    expect(subject).toBeUndefined()
    const session = (await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!
    await Storage.write(Keys.session(f.sessionID), { ...session, shareState: "shared" })
    expect((await reads.interactions(f.credentials.reader, query)).operation).toBe("pending")
    expect(subject).toBe("reader")
    await expect(
      reads.read(f.credentials.reader, { operation: "session", rootSessionID: f.sessionID }),
    ).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
    for await (const record of Storage.records({ limit: 32 }))
      expect(JSON.stringify(record.value)).not.toContain("private pending prompt fixture")
  })
})

for (const changed of ["membership", "binding"] as const)
  test(`interaction reads reauthorize ${changed} after a delayed native response`, async () => {
    await using f = await commandFixture()
    const socket = await f.connect(1, true, false, true)
    const entered = Promise.withResolvers<Frame>()
    socket.onmessage = (event) => {
      const frame = Runtime.ServerFrame.parse(JSON.parse(String(event.data)))
      if (frame.type === "command" && frame.command.kind === "interactions") entered.resolve(frame)
    }
    const reads = createSessionReadForwarder({ connections: f.connections, signing: f.signing })
    await f.run(async () => {
      const session = (await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!
      await Storage.write(Keys.session(f.sessionID), { ...session, shareState: "shared" })
      const pending = reads.interactions(f.credentials.bob, {
        operation: "pending",
        rootSessionID: f.sessionID,
        limit: 1,
      })
      void pending.catch(() => {})
      const frame = await entered.promise
      if (changed === "membership") {
        await Storage.remove(Keys.projectMember("project", "bob"))
        await Storage.remove(Keys.projectAccess("bob", "project"))
      } else
        await Storage.write(Keys.session(f.sessionID), {
          ...session,
          shareState: "shared",
          bindingEpoch: session.bindingEpoch + 1,
          nextBindingEpoch: session.nextBindingEpoch + 1,
        })
      answer(socket, frame)
      await expect(pending).rejects.toMatchObject({
        data: { code: changed === "membership" ? "NOT_FOUND" : "STALE_BINDING" },
      })
    })
  })
