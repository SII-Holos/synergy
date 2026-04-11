import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/scope/instance"
import { Log } from "../../src/util/log"
import { SessionManager } from "../../src/session/manager"
import { Session } from "../../src/session"
import { SessionEndpoint } from "../../src/session/endpoint"
import { tmpdir } from "../fixture/fixture"
import { Channel } from "../../src/channel"

Log.init({ print: false })

describe("SessionManager.getSession", () => {
  describe("by sessionID", () => {
    test("returns session info when session exists in storage", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})

          const result = await SessionManager.getSession(session.id)

          expect(result).toBeDefined()
          expect(result!.id).toBe(session.id)

          SessionManager.unregisterRuntime(session.id)
        },
      })
    })

    test("returns undefined for nonexistent session", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const result = await SessionManager.getSession("ses_nonexistent")
          expect(result).toBeUndefined()
        },
      })
    })
  })

  describe("by channel", () => {
    test("returns session matching channel", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const channel: Channel.Info = {
            type: "test",
            accountId: "acc-1",
            chatId: "chat-match",
          }
          const endpoint = SessionEndpoint.fromChannel(channel)
          const session = await Session.create({ endpoint })

          const result = await SessionManager.getSession(endpoint)

          expect(result).toBeDefined()
          expect(result!.id).toBe(session.id)

          SessionManager.unregisterRuntime(session.id)
        },
      })
    })

    test("returns undefined when no session matches channel", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const otherChannel: Channel.Info = {
            type: "test",
            accountId: "acc-other",
            chatId: "chat-other",
          }

          const result = await SessionManager.getSession(SessionEndpoint.fromChannel(otherChannel))
          expect(result).toBeUndefined()
        },
      })
    })

    test("does not return archived sessions", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const channel: Channel.Info = {
            type: "test",
            accountId: "acc-1",
            chatId: "chat-archived",
          }
          const endpoint = SessionEndpoint.fromChannel(channel)
          const session = await Session.create({ endpoint })
          await Session.update(session.id, (draft) => {
            draft.time.archived = Date.now()
          })

          const result = await SessionManager.getSession(endpoint)
          expect(result).toBeUndefined()

          SessionManager.unregisterRuntime(session.id)
        },
      })
    })
  })

  describe("runtime", () => {
    test("registerRuntime and unregisterRuntime manage runtime entries", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})

          const runtime = SessionManager.getRuntime(session.id)
          expect(runtime).toBeDefined()
          expect(runtime!.status).toEqual({ type: "idle" })

          SessionManager.unregisterRuntime(session.id)
          expect(SessionManager.getRuntime(session.id)).toBeUndefined()
        },
      })
    })
  })
})
