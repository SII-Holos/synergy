import { describe, expect, test } from "bun:test"
import { createSessionMessageLoader } from "./session-message-loader"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
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
      apply: (_sessionID, messages) => applied.push(messages),
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
