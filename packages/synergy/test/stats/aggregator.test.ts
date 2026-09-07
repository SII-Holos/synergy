import { expect, test } from "bun:test"
import { Aggregator } from "../../src/stats/aggregator"
import { fixture, complete } from "../fixture/rollout"
import { Session } from "../../src/session"
import { SessionExport } from "../../src/session/session-export"
import { SessionImport } from "../../src/session/session-import"

test("session statistics use auxiliary attempts without counting message projections twice", async () => {
  await fixture(async ({ session, call }) => {
    await complete(call)
    const result = await Aggregator.digest(session)
    expect(result.cost).toBeCloseTo(0.0105)
    expect(result.tokens).toEqual({ input: 1000, output: 500, reasoning: 100, cache: { read: 0, write: 0 } })
    expect(result.accounting?.attempts).toBe(1)
    expect(result.agentUsage.summary.cost).toBeCloseTo(0.0105)
  })
})

test("forked and imported message history preserves source costs without adding local spending", async () => {
  await fixture(async ({ session }) => {
    const fork = await Session.fork({ sessionID: session.id })
    const report = await SessionExport.generate({ sessionID: session.id, mode: "full" })
    const imported = await SessionImport.fromReport(report)
    try {
      for (const id of [fork.id, imported.rootSessionID]) {
        const messages = await Session.messages({ sessionID: id })
        const assistant = messages.find((message) => message.info.role === "assistant")!.info
        expect(assistant.role === "assistant" && assistant.cost).toBe(123)
        const result = await Aggregator.digest(await Session.get(id))
        expect(result.cost).toBe(0)
        expect(result.tokens.output).toBe(0)
        expect(result.accounting?.legacy.messages).toBe(0)
      }
    } finally {
      await Session.remove(fork.id)
      await Session.remove(imported.rootSessionID)
    }
  })
})
