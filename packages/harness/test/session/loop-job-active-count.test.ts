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

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(5)
  }
  throw new Error("timed out waiting for condition")
}

describe("LoopJob active background count", () => {
  test("counts detached runs that outlive their turn and drops them once settled", async () => {
    const baseline = LoopJob.activeBackgroundCount()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const type = `test_active_count_${crypto.randomUUID()}`
    LoopJob.register({
      type,
      phase: "post",
      blocking: false,
      detached: true,
      collect: () => [],
      capture: () => ({ type }),
      async execute() {
        started.resolve()
        await release.promise
        return "pass"
      },
    })

    const sessionID = `ses_active_count_${crypto.randomUUID()}`
    expect(LoopJob.scheduleDetached({ type, sessionID, rootID: "root_1" })).toBe(true)
    await started.promise
    await waitFor(() => LoopJob.activeBackgroundCount() === baseline + 1)

    release.resolve()
    await LoopJob.settleDetached(sessionID)
    await waitFor(() => LoopJob.activeBackgroundCount() === baseline)
  })

  test("counts lease-bound runs scheduled through execute", async () => {
    const baseline = LoopJob.activeBackgroundCount()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const type = `test_active_count_bound_${crypto.randomUUID()}`
    LoopJob.register({
      type,
      phase: "post",
      blocking: false,
      collect: () => [{ type }],
      capture: () => ({ type }),
      async execute() {
        started.resolve()
        await release.promise
        return "pass"
      },
    })

    const sessionID = `ses_active_count_bound_${crypto.randomUUID()}`
    await LoopJob.execute([{ type }], context(sessionID))
    await started.promise
    await waitFor(() => LoopJob.activeBackgroundCount() === baseline + 1)

    release.resolve()
    await LoopJob.drain(sessionID)
    await waitFor(() => LoopJob.activeBackgroundCount() === baseline)
  })
})
