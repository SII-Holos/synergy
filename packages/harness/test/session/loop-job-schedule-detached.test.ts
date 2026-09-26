import { describe, expect, test } from "bun:test"
import { LoopJob } from "../../src/session/loop-job"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

describe("LoopJob.scheduleDetached", () => {
  test("queues a registered detached job without a loop context and settles via settleDetached", () =>
    runtime.run(async () => {
      const started = Promise.withResolvers<{ sessionID: string; userMessageID: string; aborted: boolean }>()
      const release = Promise.withResolvers<void>()
      const type = `test_schedule_${crypto.randomUUID()}`
      LoopJob.register({
        type,
        phase: "post",
        blocking: false,
        detached: true,
        collect: () => [],
        capture: (_ctx, instance) => instance,
        key: (payload) => String(payload.userMessageID ?? ""),
        async execute(payload, signal) {
          started.resolve({
            sessionID: String(payload.sessionID),
            userMessageID: String(payload.userMessageID),
            aborted: signal.aborted,
          })
          await release.promise
          return "pass"
        },
      })
      const sessionID = `ses_schedule_${crypto.randomUUID()}`
      expect(
        LoopJob.scheduleDetached({
          sessionID,
          rootID: "msg_root",
          type,
          payload: { sessionID, userMessageID: "msg_user" },
        }),
      ).toBe(true)

      const observed = await started.promise
      expect(observed.sessionID).toBe(sessionID)
      expect(observed.userMessageID).toBe("msg_user")
      expect(observed.aborted).toBe(false)

      const settling = LoopJob.settleDetached(sessionID)
      expect(await Promise.race([settling.then(() => "settled"), Bun.sleep(50).then(() => "pending")])).toBe("pending")
      release.resolve()
      await settling
    }))

  test("coalesces repeat schedules for the same key into a pending run", () =>
    runtime.run(async () => {
      const firstStarted = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let runs = 0
      const type = `test_schedule_coalesce_${crypto.randomUUID()}`
      LoopJob.register({
        type,
        phase: "post",
        blocking: false,
        detached: true,
        collect: () => [],
        capture: (_ctx, instance) => instance,
        key: (payload) => String(payload.sessionID ?? ""),
        async execute(payload) {
          runs++
          if (payload.attempt === 1) {
            firstStarted.resolve()
            await release.promise
          }
          return "pass"
        },
      })
      const sessionID = `ses_coalesce_${crypto.randomUUID()}`
      expect(
        LoopJob.scheduleDetached({ sessionID, rootID: "msg_root", type, payload: { sessionID, attempt: 1 } }),
      ).toBe(true)
      await firstStarted.promise
      expect(
        LoopJob.scheduleDetached({ sessionID, rootID: "msg_root", type, payload: { sessionID, attempt: 2 } }),
      ).toBe(true)
      release.resolve()
      await LoopJob.settleDetached(sessionID)
      expect(runs).toBe(2)
    }))

  test("rejects unknown and non-detached job types", () =>
    runtime.run(async () => {
      expect(
        LoopJob.scheduleDetached({ sessionID: "ses_x", rootID: "msg_x", type: `missing_${crypto.randomUUID()}` }),
      ).toBe(false)

      const blocking = `test_sched_blocking_${crypto.randomUUID()}`
      LoopJob.register({
        type: blocking,
        phase: "post",
        blocking: true,
        collect: () => [],
        execute: async () => "pass",
      })
      expect(LoopJob.scheduleDetached({ sessionID: "ses_x", rootID: "msg_x", type: blocking })).toBe(false)

      const bound = `test_sched_bound_${crypto.randomUUID()}`
      LoopJob.register({
        type: bound,
        phase: "post",
        blocking: false,
        collect: () => [],
        capture: (_ctx, instance) => instance,
        execute: async () => "pass",
      })
      expect(LoopJob.scheduleDetached({ sessionID: "ses_x", rootID: "msg_x", type: bound })).toBe(false)
    }))
})

afterRuntimeTests(() => runtime.close())
