import { describe, expect, test } from "bun:test"
import { LoopJob } from "../../src/session/loop-job"

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
  test("executes a detached payload without retaining the full context", async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
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
        return "pass"
      },
    })

    const ctx = context("ses_detached")
    await LoopJob.execute([{ type }], ctx)
    await started.promise

    expect(received).toEqual({ type, sessionID: "ses_detached", messageID: "msg_ses_detached" })
    expect(received).not.toHaveProperty("messages")
    expect(LoopJob.backgroundStats().jobs.find((job) => job.type === type)?.payloadBytes).toBeLessThan(1024)

    release.resolve()
    await waitUntil(() => !LoopJob.backgroundStats().jobs.some((job) => job.type === type))
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

    const active = LoopJob.backgroundStats().jobs.find((job) => job.type === type)
    expect(active?.pending).toBe(true)
    releaseFirst.resolve()
    await waitUntil(() => !LoopJob.backgroundStats().jobs.some((job) => job.type === type))
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
    await waitUntil(() => !LoopJob.backgroundStats().jobs.some((job) => job.type === type))
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

    await waitUntil(() => !LoopJob.backgroundStats().jobs.some((job) => job.type === type))
    expect(seen).toEqual([1, 2])
  })
})
