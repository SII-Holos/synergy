import { describe, expect, test } from "bun:test"
import { LoopJob } from "../../src/session/loop-job"

function context(sessionID: string, abort?: AbortSignal): LoopJob.Context {
  const lastUser = {
    id: `msg_${sessionID}`,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "synergy",
    model: { providerID: "test", modelID: "test" },
  } as LoopJob.Context["lastUser"]
  return {
    session: { id: sessionID } as LoopJob.Context["session"],
    sessionID,
    step: 1,
    messages: [{ info: lastUser, parts: [] }],
    lastUser,
    lastUserParts: [],
    abort: abort ?? new AbortController().signal,
  }
}

describe("LoopJob detached background runs", () => {
  test("detached runs ignore the loop lease abort signal and settle through settleDetached", async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const completed = Promise.withResolvers<void>()
    let observedAbort = false
    const type = `test_detach_free_${crypto.randomUUID()}`
    LoopJob.register({
      type,
      phase: "post",
      blocking: false,
      detached: true,
      collect: () => [],
      capture: () => ({ type }),
      async execute(_payload, signal) {
        started.resolve()
        await release.promise
        observedAbort = signal.aborted
        completed.resolve()
        return "pass"
      },
    })
    const leaseAbort = new AbortController()
    const sessionID = `ses_detach_${crypto.randomUUID()}`
    await LoopJob.execute([{ type }], context(sessionID, leaseAbort.signal))
    await started.promise
    leaseAbort.abort()
    await Bun.sleep(10)
    expect(observedAbort).toBe(false)
    release.resolve()
    await completed.promise
    expect(observedAbort).toBe(false)
    await LoopJob.settleDetached(sessionID)
  })

  test("non-detached runs keep observing the loop lease abort signal", async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const completed = Promise.withResolvers<void>()
    let observedAbort = false
    const type = `test_detach_bound_${crypto.randomUUID()}`
    LoopJob.register({
      type,
      phase: "post",
      blocking: false,
      collect: () => [],
      capture: () => ({ type }),
      async execute(_payload, signal) {
        started.resolve()
        await release.promise
        observedAbort = signal.aborted
        completed.resolve()
        return "pass"
      },
    })
    const leaseAbort = new AbortController()
    const sessionID = `ses_bound_${crypto.randomUUID()}`
    await LoopJob.execute([{ type }], context(sessionID, leaseAbort.signal))
    await started.promise
    leaseAbort.abort()
    release.resolve()
    await completed.promise
    expect(observedAbort).toBe(true)
    await LoopJob.settleDetached(sessionID)
  })

  test("cancelDetached aborts detached runs and drops their pending payloads", async () => {
    const firstStarted = Promise.withResolvers<void>()
    const seen: number[] = []
    const type = `test_detach_cancel_${crypto.randomUUID()}`
    LoopJob.register({
      type,
      phase: "post",
      blocking: false,
      detached: true,
      collect: () => [],
      capture: (_ctx, instance) => ({ type, revision: Number(instance.revision) }),
      key: () => "same",
      async execute(payload, signal) {
        seen.push(payload.revision)
        if (payload.revision === 1) {
          firstStarted.resolve()
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve()
            else signal.addEventListener("abort", () => resolve(), { once: true })
          })
        }
        return "pass"
      },
    })
    const sessionID = `ses_detach_cancel_${crypto.randomUUID()}`
    await LoopJob.execute([{ type, revision: 1 }], context(sessionID))
    await firstStarted.promise
    await LoopJob.execute([{ type, revision: 2 }], context(sessionID))
    LoopJob.cancelDetached(sessionID)
    await LoopJob.settleDetached(sessionID)
    expect(seen).toEqual([1])
  })

  test("settleDetached surfaces recording failures from detached runs", async () => {
    const { RolloutRecordingError } = await import("../../src/session/rollout/error")
    const release = Promise.withResolvers<void>()
    const type = `test_detach_failure_${crypto.randomUUID()}`
    LoopJob.register({
      type,
      phase: "post",
      blocking: false,
      detached: true,
      collect: () => [],
      capture: () => ({ type }),
      async execute() {
        await release.promise
        throw new RolloutRecordingError({ message: "evidence failed" })
      },
    })
    const sessionID = `ses_detach_failure_${crypto.randomUUID()}`
    await LoopJob.execute([{ type }], context(sessionID))
    const settling = LoopJob.settleDetached(sessionID)
    release.resolve()
    await expect(settling).rejects.toMatchObject({ name: "RolloutRecordingError" })
  })
})
