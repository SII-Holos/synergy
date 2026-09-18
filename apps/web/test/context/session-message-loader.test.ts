import { describe, expect, test } from "bun:test"
import { createSessionMessageLoader } from "../../src/context/session-message-loader"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function recordingWait() {
  const pauses: number[] = []
  const wait = (ms: number) => {
    pauses.push(ms)
    return Promise.resolve()
  }
  return { pauses, wait }
}

describe("session message loader", () => {
  test("force starts a new generation and ignores the superseded response", async () => {
    const first = deferred<string[]>()
    const second = deferred<string[]>()
    const requests = [first, second]
    const signals: AbortSignal[] = []
    const applied: string[][] = []
    const loader = createSessionMessageLoader<string[]>({
      request: (_sessionID, signal) => {
        signals.push(signal)
        return requests.shift()!.promise
      },
      apply: (_sessionID, messages) => {
        applied.push(messages)
      },
      errorMessage: (error) => String(error),
    })

    const initial = loader.load("ses_1")
    const retry = loader.load("ses_1", { force: true })

    expect(signals).toHaveLength(2)
    expect(signals[0]?.aborted).toBe(true)
    expect(loader.state("ses_1")).toMatchObject({ phase: "loading", generation: 2, hasSnapshot: false })

    second.resolve(["fresh"])
    await retry
    first.resolve(["stale"])
    await initial

    expect(applied).toEqual([["fresh"]])
    expect(loader.state("ses_1")).toMatchObject({ phase: "ready", generation: 2, hasSnapshot: true })
  })

  test("retries a superseded snapshot before reporting the session ready", async () => {
    const { wait } = recordingWait()
    const states: string[] = []
    let requests = 0
    let applies = 0
    const loader = createSessionMessageLoader<string[]>({
      request: async () => {
        requests++
        return [requests === 1 ? "stale" : "fresh"]
      },
      apply: () => {
        applies++
        return applies === 1 ? "superseded" : "applied"
      },
      errorMessage: (error) => String(error),
      onState: (_sessionID, state) => states.push(state.phase),
      wait,
    })

    await loader.load("ses_1")

    expect(requests).toBe(2)
    expect(applies).toBe(2)
    expect(states).toEqual(["loading", "ready"])
    expect(loader.state("ses_1")).toMatchObject({ phase: "ready", generation: 1, hasSnapshot: true })
  })

  test("paces superseded retries with exponential backoff", async () => {
    const { pauses, wait } = recordingWait()
    let requests = 0
    const loader = createSessionMessageLoader<string[]>({
      request: async () => {
        requests++
        return [`page-${requests}`]
      },
      apply: (_sessionID, page) => (page[0] === "page-3" ? "applied" : "superseded"),
      errorMessage: (error) => String(error),
      wait,
    })

    await loader.load("ses_1")

    expect(requests).toBe(3)
    expect(pauses).toEqual([100, 200])
    expect(loader.state("ses_1")).toMatchObject({ phase: "ready", hasSnapshot: true })
  })

  test("fails visibly after four superseded attempts when a snapshot is visible", async () => {
    const { pauses, wait } = recordingWait()
    let requests = 0
    const loader = createSessionMessageLoader<string[]>({
      request: async () => {
        requests++
        return []
      },
      apply: () => "superseded",
      errorMessage: () => "Conversation changed while loading",
      wait,
    })

    await expect(loader.load("ses_1", { hasSnapshot: true })).rejects.toThrow("superseded")

    expect(requests).toBe(4)
    expect(pauses).toEqual([100, 200, 400])
    expect(loader.state("ses_1")).toMatchObject({
      phase: "error",
      generation: 1,
      hasSnapshot: true,
      error: "Conversation changed while loading",
    })
  })

  test("restarts the attempt window once for a first view without a snapshot", async () => {
    const { pauses, wait } = recordingWait()
    const states: string[] = []
    let requests = 0
    const loader = createSessionMessageLoader<string[]>({
      request: async () => {
        requests++
        return []
      },
      apply: () => "superseded",
      errorMessage: () => "Conversation changed while loading",
      onState: (_sessionID, state) => states.push(state.phase),
      wait,
    })

    await expect(loader.load("ses_1")).rejects.toThrow("superseded")

    expect(requests).toBe(8)
    expect(pauses).toEqual([100, 200, 400, 800, 100, 200, 400])
    expect(states).toEqual(["loading", "loading", "error"])
    expect(loader.state("ses_1")).toMatchObject({ phase: "error", hasSnapshot: false })
  })

  test("recovers a first view when the restarted attempt window applies", async () => {
    const { pauses, wait } = recordingWait()
    let applies = 0
    const loader = createSessionMessageLoader<string[]>({
      request: async () => [],
      apply: () => {
        applies++
        return applies <= 4 ? "superseded" : "applied"
      },
      errorMessage: (error) => String(error),
      wait,
    })

    await loader.load("ses_1")

    expect(applies).toBe(5)
    expect(pauses).toEqual([100, 200, 400, 800])
    expect(loader.state("ses_1")).toMatchObject({ phase: "ready", hasSnapshot: true })
  })

  test("a failed forced refresh preserves the successful snapshot state", async () => {
    const first = deferred<string[]>()
    const second = deferred<string[]>()
    const requests = [first, second]
    const loader = createSessionMessageLoader<string[]>({
      request: () => requests.shift()!.promise,
      apply: () => {},
      errorMessage: () => "Couldn’t load conversation",
    })

    const initial = loader.load("ses_1")
    first.resolve([])
    await initial

    const refresh = loader.load("ses_1", { force: true })
    expect(loader.state("ses_1")).toMatchObject({ phase: "refreshing", hasSnapshot: true })
    second.reject(new Error("offline"))
    await expect(refresh).rejects.toThrow("offline")

    expect(loader.state("ses_1")).toMatchObject({
      phase: "error",
      hasSnapshot: true,
      error: "Couldn’t load conversation",
    })
  })
})

test("releasing a pending session aborts it and cannot collide with a reopened generation", async () => {
  const first = deferred<string>(),
    second = deferred<string>()
  const requests = [first, second]
  const signals: AbortSignal[] = []
  const applied: string[] = []
  const loader = createSessionMessageLoader<string>({
    request: (_key, signal) => {
      signals.push(signal)
      return requests.shift()!.promise
    },
    apply: (_key, value) => {
      applied.push(value)
    },
    errorMessage: String,
  })
  const old = loader.load("session")
  loader.release("session")
  expect(signals[0]!.aborted).toBe(true)
  expect(loader.state("session").phase).toBe("idle")
  const current = loader.load("session")
  first.resolve("old")
  await old
  expect(applied).toEqual([])
  expect(loader.state("session").phase).toBe("loading")
  second.resolve("new")
  await current
  expect(applied).toEqual(["new"])
  loader.dispose()
})
