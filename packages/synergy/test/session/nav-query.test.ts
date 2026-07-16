import { describe, expect, test } from "bun:test"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionEndpoint } from "../../src/session/endpoint"
import { SessionNav } from "../../src/session/nav"
import { tmpdir } from "../fixture/fixture"

describe("SessionNav.queryGlobal", () => {
  test("filters by category before pagination", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const token = `category-before-pagination-${crypto.randomUUID()}`

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const channel = await Session.create({
          title: `${token} channel`,
          endpoint: SessionEndpoint.fromChannel({ type: "feishu", accountId: "nav", chatId: token }),
        })
        await Bun.sleep(5)
        const regular = await Session.create({ title: `${token} regular` })

        const result = await SessionNav.queryGlobal({
          category: "channel",
          search: token,
          limit: 1,
        })

        expect(result.total).toBe(1)
        expect(result.items.map((entry) => entry.id)).toEqual([channel.id])

        await Session.remove(regular.id)
        await Session.remove(channel.id)
      },
    })
  })
})
