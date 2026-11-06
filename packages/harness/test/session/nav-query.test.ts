import { describe, expect, test } from "bun:test"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { Session } from "../../src/session"
import { SessionEndpoint } from "../../src/session/endpoint"
import { SessionNav } from "../../src/session/nav"
import { tmpdir } from "../support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

describe("SessionNav.queryGlobal", () => {
  test("filters sessions by normalized tag before pagination", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()
      const token = `tag-normalization-${crypto.randomUUID()}`

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const tagged = await Session.create({
            title: `${token} tagged`,
            tags: ["## focus", " # # focus", "focus"],
          })
          await Session.create({ title: `${token} other`, tags: ["later"] })

          expect(tagged.tags).toEqual(["focus"])
          expect((await Session.get(tagged.id)).tags).toEqual(tagged.tags)
          expect(await Session.list({ tag: "#focus" })).toMatchObject({
            data: [expect.objectContaining({ id: tagged.id, tags: ["focus"] })],
            total: 1,
          })

          const scopeFocus = await SessionNav.queryScope(scope.id, { tag: "# focus", limit: 20 })
          const scopeCanonical = await SessionNav.queryScope(scope.id, { tag: "focus", limit: 20 })
          expect([scopeFocus.total, scopeFocus.items.map((entry) => entry.id)]).toEqual([
            scopeCanonical.total,
            scopeCanonical.items.map((entry) => entry.id),
          ])
          expect(scopeFocus.total).toBe(1)
          expect(scopeFocus.items[0]?.id).toBe(tagged.id)

          const globalFocus = await SessionNav.queryGlobal({
            search: token,
            tag: " #focus",
            parentOnly: false,
            limit: 20,
          })
          const globalCanonical = await SessionNav.queryGlobal({
            search: token,
            tag: "focus",
            parentOnly: false,
            limit: 20,
          })
          expect(globalFocus.total).toBe(globalCanonical.total)
          expect(globalFocus.items.map((entry) => entry.id)).toEqual(globalCanonical.items.map((entry) => entry.id))
          expect(globalFocus.total).toBe(1)
          expect(globalFocus.items[0]?.id).toBe(tagged.id)

          expect(await SessionNav.queryScope(scope.id, { tag: "" })).toMatchObject({ items: [], total: 0 })
          expect(await SessionNav.queryGlobal({ tag: "#", parentOnly: false })).toMatchObject({
            items: [],
            total: 0,
          })

          for (const session of (await Session.list({ limit: 100 })).data) await Session.remove(session.id)
        },
      })
    }))

  test("filters by category before pagination", () =>
    runtime.run(async () => {
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
    }))

  test("filters Channel provider before pagination", () =>
    runtime.run(async () => {
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
    }))

  test("excludes sessions owned by archived project scopes", () =>
    runtime.run(async () => {
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
    }))

  test("persists GitHub provenance and queries GitHub sessions across parent and child entries", () =>
    runtime.run(async () => {
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
    }))
})

afterRuntimeTests(() => runtime.close())
