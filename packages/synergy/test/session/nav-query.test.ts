import { describe, expect, test } from "bun:test"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
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

  test("filters Channel provider before pagination", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const token = `channel-provider-before-pagination-${crypto.randomUUID()}`

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const feishu = await Session.create({
          title: `${token} feishu`,
          endpoint: SessionEndpoint.fromChannel({ type: "feishu", accountId: "nav", chatId: token }),
        })
        await Bun.sleep(5)
        const clarus = await Session.create({
          title: `${token} clarus`,
          endpoint: SessionEndpoint.fromChannel({
            type: "clarus",
            accountId: "nav",
            target: { kind: "task", externalProjectId: token, externalTaskId: token },
          }),
        })

        const result = await SessionNav.queryGlobal({
          category: "channel",
          channelType: "feishu",
          search: token,
          limit: 1,
        })

        expect(result.total).toBe(1)
        expect(result.items.map((entry) => entry.id)).toEqual([feishu.id])

        await Session.remove(clarus.id)
        await Session.remove(feishu.id)
      },
    })
  })

  test("excludes sessions owned by archived project scopes", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const token = `archived-scope-${crypto.randomUUID()}`
    const session = await ScopeContext.provide({
      scope,
      fn: () =>
        Session.create({
          title: token,
          endpoint: SessionEndpoint.fromChannel({ type: "feishu", accountId: "nav", chatId: token }),
        }),
    })

    await Scope.remove(scope.id)

    const result = await SessionNav.queryGlobal({
      category: "channel",
      channelType: "feishu",
      search: token,
    })
    expect(result).toMatchObject({ items: [], total: 0 })

    await ScopeContext.provide({ scope, fn: () => Session.remove(session.id) })
  })

  test("persists GitHub provenance and queries GitHub sessions across parent and child entries", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const token = `github-provenance-${crypto.randomUUID()}`

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const parent = await Session.create({ title: `${token} parent`, provenance: "github" })
        const child = await Session.create({
          title: `${token} child`,
          parentID: parent.id,
          provenance: "github",
        })
        const background = await Session.create({ title: `${token} background`, parentID: parent.id })

        expect(await Session.get(child.id)).toMatchObject({ provenance: "github", category: "github" })

        const result = await SessionNav.queryGlobal({
          category: "github",
          parentOnly: false,
          search: token,
        })

        expect(result.total).toBe(2)
        expect(result.items.map((entry) => entry.id).sort()).toEqual([child.id, parent.id].sort())
        expect(result.items.every((entry) => entry.category === "github")).toBe(true)

        await Session.remove(background.id)
        await Session.remove(child.id)
        await Session.remove(parent.id)
      },
    })
  })
})
