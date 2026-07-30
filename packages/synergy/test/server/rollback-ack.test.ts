import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionHistory } from "../../src/session/history"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"

Log.init({ print: false })

async function writeTurn(sessionID: string, cwd: string, userText: string, assistantText: string) {
  const info = await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID,
    agent: "default",
    model: { providerID: "openai", modelID: "gpt-4" },
    time: { created: Date.now() },
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: info.id,
    sessionID,
    type: "text",
    text: userText,
  })
  const aInfo = await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "assistant",
    sessionID,
    mode: "default",
    agent: "default",
    path: { cwd, root: cwd },
    cost: 0,
    tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "gpt-4",
    providerID: "openai",
    parentID: info.id,
    time: { created: Date.now() },
    finish: "end_turn",
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: aInfo.id,
    sessionID,
    type: "text",
    text: assistantText,
  })
}

describe("rollback acknowledge route", () => {
  test("POST /session/:sessionID/rollback/ack acknowledges current rollback", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})
        await writeTurn(session.id, tmp.path, "first", "one")
        await writeTurn(session.id, tmp.path, "second", "two")

        const rollback = (await Session.rollback({
          sessionID: session.id,
          numTurns: 1,
        })) as SessionHistory.RollbackEvent

        const response = await app.request(`/session/${session.id}/rollback/ack`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rollbackID: rollback.id }),
        })

        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body.rollbackAck).toBeDefined()
        expect(body.rollbackAck.rollbackID).toBe(rollback.id)
        expect(typeof body.rollbackAck.acknowledgedAt).toBe("number")

        await Session.remove(session.id)
      },
    })
  })

  test("POST /session/:sessionID/rollback/ack repeated is idempotent", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})
        await writeTurn(session.id, tmp.path, "first", "one")

        const rollback = (await Session.rollback({
          sessionID: session.id,
          numTurns: 1,
        })) as SessionHistory.RollbackEvent

        const first = await app.request(`/session/${session.id}/rollback/ack`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rollbackID: rollback.id }),
        })
        const firstBody = await first.json()

        const second = await app.request(`/session/${session.id}/rollback/ack`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rollbackID: rollback.id }),
        })
        const secondBody = await second.json()

        expect(second.status).toBe(200)
        expect(secondBody.rollbackAck.acknowledgedAt).toBe(firstBody.rollbackAck.acknowledgedAt)

        await Session.remove(session.id)
      },
    })
  })

  test("POST /session/:sessionID/rollback/ack rejects missing rollbackID body", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})

        const response = await app.request(`/session/${session.id}/rollback/ack`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })

        expect(response.status).toBe(400)

        await Session.remove(session.id)
      },
    })
  })

  test("POST /session/:sessionID/rollback/ack rejects when no rollback is active", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})

        const response = await app.request(`/session/${session.id}/rollback/ack`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rollbackID: Identifier.ascending("history") }),
        })

        expect(response.status).toBe(409)

        await Session.remove(session.id)
      },
    })
  })
})
