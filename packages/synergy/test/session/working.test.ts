import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/scope/instance"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import * as SessionWorking from "../../src/session/working"
import { Identifier } from "../../src/id/id"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

function assertExists<T>(value: T | undefined): asserts value is T {
  if (value === undefined) throw new Error("expected defined value")
}

describe("SessionWorking", () => {
  describe("resolve()", () => {
    test("returns undefined for idle session with no messages", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const result = await SessionWorking.resolve(session.id)
          expect(result).toBeUndefined()
        },
      })
    })

    test("returns busy when runtime is active", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const runtime = SessionManager.registerRuntime(session.id)
          const controller = new AbortController()
          runtime.abort = controller
          runtime.status = { type: "busy", description: "testing" }

          const result = await SessionWorking.resolve(session.id)
          assertExists(result)
          expect(result.status).toBe("busy")
          if (result.status === "busy") expect(result.description).toBe("testing")

          runtime.abort = undefined
          SessionManager.unregisterRuntime(session.id)
        },
      })
    })

    test("returns retry when runtime is retrying", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const runtime = SessionManager.registerRuntime(session.id)
          const controller = new AbortController()
          runtime.abort = controller
          const now = Date.now()
          runtime.status = {
            type: "retry",
            attempt: 3,
            message: "API error",
            next: now + 5000,
          }

          const result = await SessionWorking.resolve(session.id)
          assertExists(result)
          expect(result.status).toBe("retry")
          if (result.status === "retry") {
            expect(result.attempt).toBe(3)
            expect(result.message).toBe("API error")
            expect(result.next).toBeGreaterThan(now)
          }

          runtime.abort = undefined
          SessionManager.unregisterRuntime(session.id)
        },
      })
    })

    test("ignores stored pendingReply without runtime work", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          await Session.update(session.id, (draft) => {
            draft.pendingReply = true
          })

          const result = await SessionWorking.resolve(session.id)
          expect(result).toBeUndefined()
        },
      })
    })

    test("returns recovering when last assistant message lacks time.completed", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const userMsg = await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "user",
            agent: "test",
            model: { providerID: "test-provider", modelID: "test-model" },
            time: { created: Date.now() },
          })
          await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "assistant",
            parentID: userMsg.id,
            time: { created: Date.now() },
            modelID: "test-model",
            providerID: "test-provider",
            path: { cwd: projectRoot, root: projectRoot },
            mode: "test",
            agent: "test",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })

          const result = await SessionWorking.resolve(session.id)
          assertExists(result)
          expect(result.status).toBe("recovering")
        },
      })
    })
  })

  describe("toStatus()", () => {
    test("converts busy WorkingInfo to StatusInfo", () => {
      const result = SessionWorking.toStatus({ status: "busy", description: "cooking" })
      expect(result).toEqual({ type: "busy", description: "cooking" })
    })

    test("converts retry WorkingInfo to StatusInfo", () => {
      const now = Date.now()
      const result = SessionWorking.toStatus({
        status: "retry",
        attempt: 2,
        message: "timeout",
        next: now,
      })
      expect(result).toEqual({ type: "retry", attempt: 2, message: "timeout", next: now })
    })

    test("converts recovering WorkingInfo to StatusInfo", () => {
      const result = SessionWorking.toStatus({ status: "recovering" })
      expect(result).toEqual({ type: "recovering" })
    })
  })
})
