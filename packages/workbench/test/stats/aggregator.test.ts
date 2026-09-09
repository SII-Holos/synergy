import { SessionUsage } from "@ericsanchezok/synergy-harness/test/internal/session/usage"
import { expect, test } from "bun:test"
import { Aggregator } from "../../src/stats/aggregator"
import { fixture, complete } from "@ericsanchezok/synergy-harness/test/support/rollout"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionExport } from "@ericsanchezok/synergy-harness/session/session-export"
import { SessionImport } from "@ericsanchezok/synergy-harness/session/session-import"

test("session statistics use auxiliary attempts without counting message projections twice", async () => {
  await fixture(async ({ session, call }) => {
    await complete(call)
    const result = await Aggregator.digest(session)
    const core = await SessionUsage.read(session)
    expect(core).toMatchObject({ cost: result.cost, tokens: result.tokens, accounting: result.accounting })
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
        const child = await Session.get(id)
        const result = await Aggregator.digest(child)
        expect(await SessionUsage.read(child)).toMatchObject({
          cost: result.cost,
          tokens: result.tokens,
          accounting: result.accounting,
        })
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
