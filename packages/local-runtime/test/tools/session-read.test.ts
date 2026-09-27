import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { describe, expect, spyOn, test } from "bun:test"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionMemoryPressure } from "@ericsanchezok/synergy-harness/session/memory-pressure"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { SessionReadTool } from "../../src/tools/session-read"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

runtime.run(() => Log.init({ print: false }))

const ctx = {
  sessionID: "ses_reader",
  messageID: "msg_reader",
  callID: "call_reader",
  agent: "session-historian",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

async function writeMessage(sessionID: string, text: string, created: number) {
  const message = (await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "user",
    time: { created },
    agent: "synergy",
    model: { providerID: "test", modelID: "test" },
  })) as MessageV2.User
  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID,
    messageID: message.id,
    type: "text",
    text,
    origin: "user",
  })
  return message.id
}

describe("session_read", () => {
  test("hydrates only the requested page from a longer session", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({ title: "Long history" })
          const messageIDs: string[] = []
          for (let index = 0; index < 12; index++) {
            messageIDs.push(await writeMessage(session.id, `message ${index}`, 100 + index))
          }

          using parts = spyOn(MessageV2, "parts")
          using release = spyOn(SessionMemoryPressure, "signalRelease").mockImplementation(() => {})
          const tool = await SessionReadTool.init()
          const result = await tool.execute({ target: session.id, limit: 3, offset: 5 }, ctx)

          expect(parts.mock.calls.map(([input]) => input.messageID).sort()).toEqual(messageIDs.slice(4, 7).sort())
          for (const index of [4, 5, 6]) expect(result.output).toContain(`message ${index}`)
          expect(result.metadata).toMatchObject({ sessionID: session.id, total: 12, shown: 3 })
          expect(release).toHaveBeenCalledWith(expect.objectContaining({ phase: "tool.session_read.complete" }))
          expect(release.mock.calls[0]?.[0]).not.toHaveProperty("forceFull")
        },
      })
    }))

  test("skips an unreadable message and returns the rest of the page", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({ title: "Partially corrupt history" })
          await writeMessage(session.id, "healthy message", 100)
          const corrupt = (await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "user",
            time: { created: 101 },
            agent: "synergy",
            model: { providerID: "test", modelID: "test" },
          })) as MessageV2.User
          const brokenPart = {
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: corrupt.id,
            type: "attachment",
            mime: "application/octet-stream",
            url: "data:broken",
          }
          await Storage.write(
            StoragePath.messagePart(
              Identifier.asScopeID(session.scope.id),
              Identifier.asSessionID(session.id),
              Identifier.asMessageID(corrupt.id),
              Identifier.asPartID(brokenPart.id),
            ),
            brokenPart,
          )

          using release = spyOn(SessionMemoryPressure, "signalRelease").mockImplementation(() => {})
          const tool = await SessionReadTool.init()
          const result = await tool.execute({ target: session.id, limit: 20, offset: 0 }, ctx)

          expect(result.metadata).toMatchObject({ sessionID: session.id, total: 2, shown: 1 })
          expect(result.output).toContain("healthy message")
          expect(release).toHaveBeenCalledTimes(1)
        },
      })
    }))
})

afterRuntimeTests(() => runtime.close())
