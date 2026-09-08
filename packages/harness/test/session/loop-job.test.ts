import { describe, expect, test } from "bun:test"
import { LoopJob } from "../../src/session/loop-job"
import { AsyncLocalStorage } from "node:async_hooks"

function context(sessionID: string, step = 1): LoopJob.Context {
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
    step,
    messages: [{ info: lastUser, parts: [{ type: "text", text: "large-history".repeat(10_000) } as any] }],
    lastUser,
    lastUserParts: [],
    abort: new AbortController().signal,
  }
}

async function waitUntil(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return
    await Bun.sleep(5)
  }
  throw new Error("condition did not settle")
}

describe("LoopJob background execution", () => {
  test("coalesced jobs restore the context captured by their own scheduling call", async () => {
    const contextStorage = new AsyncLocalStorage<string>()
    const release = Promise.withResolvers<void>()
    const seen: Array<string | undefined> = []
    const type = `test_context_${crypto.randomUUID()}`
    LoopJob.register({
      type,
      phase: "post",
      blocking: false,
      collect: () => [],
      capture: () => ({ type }),
      key: () => "same",
      async execute() {
        seen.push(contextStorage.getStore())
        if (seen.length === 1) await release.promise
        return "pass"
      },
    })
    const ctx = context(`ses_${crypto.randomUUID()}`)
    await contextStorage.run("first", () => LoopJob.execute([{ type }], ctx))
    await contextStorage.run("second", () => LoopJob.execute([{ type }], ctx))
    release.resolve()
    await LoopJob.drain(ctx.sessionID)
    expect(seen).toEqual(["first", "second"])
  })
  test("executes a detached payload without retaining the full context", async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const completed = Promise.withResolvers<void>()
    let received: LoopJob.JobInstance | undefined
    const type = `test_detached_${Date.now()}_${Math.random()}`
    LoopJob.register({
      type,
      phase: "post",
      blocking: false,
      collect() {
        return []
      },
      capture(ctx) {
        return { type, sessionID: ctx.sessionID, messageID: ctx.lastUser.id }
      },
      async execute(payload) {
        received = payload
        started.resolve()
        await release.promise
        completed.resolve()
        return "pass"
      },
    })

    const ctx = context("ses_detached")
    await LoopJob.execute([{ type }], ctx)
    await started.promise

    expect(received).toEqual({ type, sessionID: "ses_detached", messageID: "msg_ses_detached" })
    expect(received).not.toHaveProperty("messages")

    release.resolve()
    await completed.promise
  })

  test("coalesces repeated work to the latest pending payload", async () => {
    const firstStarted = Promise.withResolvers<void>()
    const releaseFirst = Promise.withResolvers<void>()
    const seen: number[] = []
    const type = `test_coalesce_${Date.now()}_${Math.random()}`
    LoopJob.register({
      type,
      phase: "post",
      blocking: false,
      collect() {
        return []
      },
      capture(ctx, instance) {
        return { type, sessionID: ctx.sessionID, revision: Number(instance.revision) }
      },
      key(payload) {
        return payload.sessionID
      },
      async execute(payload) {
        seen.push(payload.revision)
        if (payload.revision === 1) {
          firstStarted.resolve()
          await releaseFirst.promise
        }
        return "pass"
      },
    })

    const ctx = context("ses_coalesce")
    await LoopJob.execute([{ type, revision: 1 }], ctx)
    await firstStarted.promise
    await LoopJob.execute([{ type, revision: 2 }], ctx)
    await LoopJob.execute([{ type, revision: 3 }], ctx)

    releaseFirst.resolve()
    await waitUntil(() => seen.length === 2)
    expect(seen).toEqual([1, 3])
  })

  test("runs every payload unless a job explicitly opts into coalescing", async () => {
    const release = Promise.withResolvers<void>()
    const seen: number[] = []
    const type = `test_distinct_${Date.now()}_${Math.random()}`
    LoopJob.register({
      type,
      phase: "post",
      blocking: false,
      collect() {
        return []
      },
      capture(ctx, instance) {
        return { type, sessionID: ctx.sessionID, revision: Number(instance.revision) }
      },
      async execute(payload) {
        seen.push(payload.revision)
        await release.promise
        return "pass"
      },
    })

    const ctx = context("ses_distinct")
    await LoopJob.execute([{ type, revision: 1 }], ctx)
    await LoopJob.execute([{ type, revision: 2 }], ctx)
    await LoopJob.execute([{ type, revision: 3 }], ctx)
    await waitUntil(() => seen.length === 3)

    release.resolve()
    expect(seen).toEqual([1, 2, 3])
  })

  test("times out a stuck run and advances its pending payload", async () => {
    const firstStarted = Promise.withResolvers<void>()
    const seen: number[] = []
    const type = `test_timeout_${Date.now()}_${Math.random()}`
    LoopJob.register({
      type,
      phase: "post",
      blocking: false,
      timeoutMs: 20,
      collect() {
        return []
      },
      capture(ctx, instance) {
        return { type, sessionID: ctx.sessionID, revision: Number(instance.revision) }
      },
      key(payload) {
        return payload.sessionID
      },
      async execute(payload, signal) {
        seen.push(payload.revision)
        if (payload.revision === 1) {
          firstStarted.resolve()
          await new Promise<void>((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          )
        }
        return "pass"
      },
    })

    const ctx = context("ses_timeout")
    await LoopJob.execute([{ type, revision: 1 }], ctx)
    await firstStarted.promise
    await LoopJob.execute([{ type, revision: 2 }], ctx)

    await waitUntil(() => seen.length === 2)
    expect(seen).toEqual([1, 2])
  })
})

test("drain waits for timeout cleanup before starting the next owned payload", async () => {
  const timedOut = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const seen: number[] = []
  const type = `test_drain_${crypto.randomUUID()}`
  LoopJob.register({
    type,
    phase: "post",
    blocking: false,
    timeoutMs: 20,
    collect: () => [],
    capture: (ctx, instance) => ({ type, sessionID: ctx.sessionID, revision: Number(instance.revision) }),
    key: (payload) => payload.sessionID,
    async execute(payload, signal) {
      seen.push(payload.revision)
      if (payload.revision === 1) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
        timedOut.resolve()
        await release.promise
      }
      return "pass"
    },
  })
  const ctx = context("ses_drain")
  await LoopJob.execute([{ type, revision: 1 }], ctx)
  await LoopJob.execute([{ type, revision: 2 }], ctx)
  await timedOut.promise
  await Bun.sleep(5)
  expect(seen).toEqual([1])
  let drained = false
  const draining = LoopJob.drain(ctx.sessionID, ctx.lastUser.id).then(() => {
    drained = true
  })
  await Bun.sleep(5)
  expect(drained).toBe(false)
  release.resolve()
  await draining
  expect(seen).toEqual([1, 2])
})

test("coalescing and draining never cross root task ownership", async () => {
  const release = Promise.withResolvers<void>()
  const type = `test_roots_${crypto.randomUUID()}`
  const seen: string[] = []
  LoopJob.register({
    type,
    phase: "post",
    blocking: false,
    collect: () => [],
    capture: (ctx) => ({ type, rootID: ctx.lastUser.id }),
    key: () => "same-session",
    async execute(payload) {
      seen.push(payload.rootID)
      if (payload.rootID === "first") await release.promise
      return "pass"
    },
  })
  const first = context("ses_roots")
  first.lastUser.id = "first"
  const second = context("ses_roots")
  second.lastUser.id = "second"
  await LoopJob.execute([{ type }], first)
  await LoopJob.execute([{ type }], second)
  await LoopJob.drain(second.sessionID, second.lastUser.id)
  expect(seen).toEqual(["first", "second"])
  release.resolve()
  await LoopJob.drain(first.sessionID, first.lastUser.id)
})

test("recording failure stops queued work and remains visible to the owning drain", async () => {
  const { RolloutRecordingError } = await import("../../src/session/rollout/error")
  const release = Promise.withResolvers<void>()
  const type = `test_failure_${crypto.randomUUID()}`
  let executions = 0
  LoopJob.register({
    type,
    phase: "post",
    blocking: false,
    collect: () => [],
    capture: () => ({ type }),
    key: () => "same",
    async execute() {
      executions++
      await release.promise
      throw new RolloutRecordingError({ message: "evidence failed" })
    },
  })
  const ctx = context("ses_failure")
  await LoopJob.execute([{ type }], ctx)
  await LoopJob.execute([{ type }], ctx)
  release.resolve()
  await expect(LoopJob.drain(ctx.sessionID, ctx.lastUser.id)).rejects.toMatchObject({ name: "RolloutRecordingError" })
  expect(executions).toBe(1)
})

test("runtime drain waits for background jobs belonging to already-finished session owners", async () => {
  const release = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const type = `test_runtime_drain_${crypto.randomUUID()}`
  LoopJob.register({
    type,
    phase: "post",
    blocking: false,
    collect: () => [],
    capture: () => ({ type }),
    async execute() {
      started.resolve()
      await release.promise
      return "pass"
    },
  })
  await LoopJob.execute([{ type }], context(`ses_completed_${crypto.randomUUID()}`))
  await started.promise
  let drained = false
  const completion = LoopJob.drainAll().then(() => {
    drained = true
  })
  await Promise.resolve()
  expect(drained).toBe(false)
  release.resolve()
  await completion
  expect(drained).toBe(true)
  await LoopJob.drainAll()
})
