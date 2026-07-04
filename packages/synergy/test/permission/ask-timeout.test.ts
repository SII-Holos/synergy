import { test, expect } from "bun:test"
import { PermissionNext } from "../../src/permission/next"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

test("PermissionNext.ask rejects when timeout signal fires while pending", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const controller = new AbortController()

      const sessionID = "ses_ask_timeout"

      const result = PermissionNext.ask({
        sessionID,
        permission: "file_search",
        patterns: ["src/*.ts"],
        metadata: {},
        ruleset: [{ permission: "file_search", pattern: "*", action: "ask" }],
        signal: controller.signal,
      })

      // Simulate the tool timeout firing (as startToolTimeout would after toolTimeoutMs)
      const timeoutMs = 300_000
      const timeout = new AbortController()
      const combinedSignal = AbortSignal.any([controller.signal, timeout.signal])
      setTimeout(() => timeout.abort(), 10)

      const secondResult = PermissionNext.ask({
        sessionID: "ses_ask_timeout_2",
        permission: "file_search",
        patterns: ["src/*.ts"],
        metadata: {},
        ruleset: [{ permission: "file_search", pattern: "*", action: "ask" }],
        signal: combinedSignal,
      })

      const [firstSettled, secondSettled] = await Promise.all([
        Promise.race([
          result
            .then(() => "resolved" as const)
            .catch((e: unknown) => (e instanceof DOMException && e.name === "AbortError" ? "aborted" : "other-error")),
          new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
        ]),
        Promise.race([
          secondResult
            .then(() => "resolved" as const)
            .catch((e: unknown) => (e instanceof DOMException && e.name === "AbortError" ? "aborted" : "other-error")),
          new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
        ]),
      ])

      // The first ask has a signal that never fires (simulating sessionAbort) —
      // it should NOT resolve or reject within the 500ms window.
      expect(firstSettled).toBe("timeout")

      // The second ask has a combined signal with a 10ms timeout —
      // it should abort quickly.
      expect(secondSettled).toBe("aborted")

      // Cleanup
      const pending = await PermissionNext.list()
      for (const entry of pending) {
        if (entry.sessionID === sessionID || entry.sessionID === "ses_ask_timeout_2") {
          await PermissionNext.reply({ requestID: entry.id, reply: "once" })
        }
      }
      result.catch(() => {})
      secondResult.catch(() => {})
      controller.abort()
    },
  })
})

test("PermissionNext.ask rejects when combined AbortSignal fires via tool timeout", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      // Simulate the startToolTimeout pattern:
      // sessionAbort + timeout → combinedAbort → ctx.abort
      const sessionController = new AbortController()
      const sessionAbort = sessionController.signal

      const timeout = new AbortController()
      const timer = setTimeout(() => timeout.abort(), 10)

      // This is exactly what startToolTimeout returns
      const combinedAbort = AbortSignal.any([sessionAbort, timeout.signal])

      const sessionID = "ses_combined_timeout"

      const result = PermissionNext.ask({
        sessionID,
        permission: "file_search",
        patterns: ["src/*.ts"],
        metadata: {},
        ruleset: [{ permission: "file_search", pattern: "*", action: "ask" }],
        signal: combinedAbort,
      })

      const settled = await Promise.race([
        result
          .then(() => "resolved" as const)
          .catch((e: unknown) => (e instanceof DOMException && e.name === "AbortError" ? "aborted" : "other-error")),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
      ])

      clearTimeout(timer)

      expect(settled).toBe("aborted")

      // Cleanup
      const pending = await PermissionNext.list()
      for (const entry of pending) {
        if (entry.sessionID === sessionID) {
          await PermissionNext.reply({ requestID: entry.id, reply: "once" })
        }
      }
      result.catch(() => {})
      sessionController.abort()
    },
  })
})
