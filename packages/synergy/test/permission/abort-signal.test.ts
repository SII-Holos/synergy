import { test, expect } from "bun:test"
import { PermissionNext } from "../../src/permission/next"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

test("ask - rejects with AbortError when AbortSignal is already aborted", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const abortedSignal = AbortSignal.abort()

      const result = PermissionNext.ask({
        sessionID: "ses_abort_already",
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        signal: abortedSignal,
      })

      const settled = await Promise.race([
        result
          .then(() => "resolved" as const)
          .catch((e: unknown) => (e instanceof DOMException && e.name === "AbortError" ? "aborted" : "other-error")),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
      ])

      expect(settled).toBe("aborted")

      const pending = await PermissionNext.list()
      const leftover = pending.find((r) => r.sessionID === "ses_abort_already")
      if (leftover) {
        await PermissionNext.reply({ requestID: leftover.id, reply: "once" })
      }
      result.catch(() => {})
    },
  })
})

test("ask - rejects with AbortError when AbortSignal fires while pending", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const controller = new AbortController()

      const result = PermissionNext.ask({
        sessionID: "ses_abort_while_pending",
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        signal: controller.signal,
      })

      setTimeout(() => controller.abort(), 50)

      const settled = await Promise.race([
        result
          .then(() => "resolved" as const)
          .catch((e: unknown) => (e instanceof DOMException && e.name === "AbortError" ? "aborted" : "other-error")),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1000)),
      ])

      expect(settled).toBe("aborted")

      const pending = await PermissionNext.list()
      const leftover = pending.find((r) => r.sessionID === "ses_abort_while_pending")
      if (leftover) {
        await PermissionNext.reply({ requestID: leftover.id, reply: "once" })
      }
      result.catch(() => {})
    },
  })
})

test("ask - resolves normally on reply when no abort signal is provided", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const askPromise = PermissionNext.ask({
        id: "perm_no_signal",
        sessionID: "ses_no_signal",
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      })

      await PermissionNext.reply({ requestID: "perm_no_signal", reply: "once" })
      await expect(askPromise).resolves.toBeUndefined()
    },
  })
})

test("ask - resolves normally on reply when signal is provided but never fires", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const controller = new AbortController()

      const askPromise = PermissionNext.ask({
        id: "perm_signal_unfired",
        sessionID: "ses_signal_unfired",
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        signal: controller.signal,
      })

      await PermissionNext.reply({ requestID: "perm_signal_unfired", reply: "once" })
      await expect(askPromise).resolves.toBeUndefined()
      controller.abort()
    },
  })
})
