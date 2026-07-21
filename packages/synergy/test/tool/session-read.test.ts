import { describe, expect, spyOn, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionMemoryPressure } from "../../src/session/memory-pressure"
import type { MessageV2 } from "../../src/session/message-v2"
import { Storage } from "../../src/storage/storage"
import { SessionReadTool } from "../../src/tool/session-read"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

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
}

describe("session_read", () => {
  test("hydrates only the requested page from a longer session", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Long history" })
        for (let index = 0; index < 12; index++) {
          await writeMessage(session.id, `message ${index}`, 100 + index)
        }

        using readMany = spyOn(Storage, "readMany")
        using release = spyOn(SessionMemoryPressure, "signalRelease").mockImplementation(() => {})
        const tool = await SessionReadTool.init()
        const result = await tool.execute({ target: session.id, limit: 3, offset: 5 }, ctx)

        const partReads = readMany.mock.calls.filter((call) => {
          const keys = call[0] as string[][]
          return keys.some((key) => key.at(-2) === "parts")
        })
        expect(partReads).toHaveLength(3)
        expect(result.metadata).toMatchObject({ sessionID: session.id, total: 12, shown: 3 })
        expect(release).toHaveBeenCalledWith(expect.objectContaining({ phase: "tool.session_read.complete" }))
        expect(release.mock.calls[0]?.[0]).not.toHaveProperty("forceFull")
      },
    })
  })

  test("skips an unreadable message and returns the rest of the page", async () => {
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
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: corrupt.id,
          type: "attachment",
          mime: "application/octet-stream",
          url: "data:broken",
        })

        using release = spyOn(SessionMemoryPressure, "signalRelease").mockImplementation(() => {})
        const tool = await SessionReadTool.init()
        const result = await tool.execute({ target: session.id, limit: 20, offset: 0 }, ctx)

        expect(result.metadata).toMatchObject({ sessionID: session.id, total: 2, shown: 1 })
        expect(result.output).toContain("healthy message")
        expect(release).toHaveBeenCalledTimes(1)
      },
    })
  })
})
