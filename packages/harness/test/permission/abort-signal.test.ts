import { test, expect } from "bun:test"
import { PermissionNext } from "../../src/permission/next"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
import { Bus } from "../../src/bus"
import { RolloutExecution } from "../../src/session/rollout/execution"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutSnapshot } from "../../src/session/rollout/snapshot"
const runtime = await testRuntime()

test("ask - rejects with AbortError when AbortSignal is already aborted", () =>
  runtime.run(async () => {
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
  }))

test("ask - rejects with AbortError when AbortSignal fires while pending", () =>
  runtime.run(async () => {
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
  }))

test("ask - resolves normally on reply when no abort signal is provided", () =>
  runtime.run(async () => {
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
  }))

test("ask - resolves normally on reply when signal is provided but never fires", () =>
  runtime.run(async () => {
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
  }))

test.each(["once", "reject", "abort"] as const)("permission %s freezes execution and ignores late replies", (reply) =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const owner = { kind: "operation" as const, scopeID: "test", operationID: crypto.randomUUID() }
        const segment = await RolloutLedger.beginSegment({ owner, runID: "permission", input: {} })
        const controller = new AbortController()
        const asked = Promise.withResolvers<string>()
        const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, (event) => asked.resolve(event.properties.id))
        const work = RolloutExecution.provide({ owner, runID: segment.runID, signal: controller.signal }, async () => {
          await RolloutExecution.start(segment)
          try {
            await PermissionNext.ask({
              sessionID: "ses_execution_wait",
              permission: "bash",
              patterns: ["ls"],
              metadata: {},
              ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
              signal: controller.signal,
            })
          } catch (error) {
            if (reply === "once") throw error
          } finally {
            await RolloutExecution.stop(segment)
          }
        })
        try {
          const requestID = await asked.promise
          const before = RolloutExecution.measure((await RolloutSnapshot.read(owner)).intervals)
          expect(before).toMatchObject({ elapsedActive: false, waiting: true })
          const sample = RolloutExecution.clock()
          expect(
            RolloutExecution.measure((await RolloutSnapshot.read(owner)).intervals, {
              ...sample,
              now: sample.now + 60000,
            }),
          ).toEqual(before)
          if (reply === "abort") controller.abort()
          else await PermissionNext.reply({ requestID, reply })
          await work
          const completed = await RolloutSnapshot.read(owner)
          expect(RolloutExecution.measure(completed.intervals)).toMatchObject({ elapsedActive: false, waiting: false })
          await PermissionNext.reply({ requestID, reply: "once" })
          expect(await RolloutSnapshot.read(owner)).toEqual(completed)
        } finally {
          unsubscribe()
          controller.abort()
        }
      },
    })
  }),
)

afterRuntimeTests(() => runtime.close())
