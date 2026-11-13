import { expect, test } from "bun:test"
import { SessionReadSource } from "../../src/session/read-source"
import { testRuntime } from "../support/runtime"

test("a composed Session reader isolates native callers and detaches its query and result", async () => {
  const entered = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  const response: SessionReadSource.Resolution = {
    kind: "projection",
    result: { title: "Authorized projection", output: "Selected shared bytes", metadata: { versions: [1] } },
  }
  let observed: Readonly<SessionReadSource.Input> | undefined
  await using guarded = await testRuntime({
    register() {
      SessionReadSource.register({
        async resolve(input) {
          observed = input
          entered.resolve()
          await proceed.promise
          return response
        },
      })
    },
  })
  await using native = await testRuntime()
  const input = {
    callerSessionID: "ses_reader",
    targetSessionID: "ses_shared",
    limit: 4,
    offset: 2,
    signal: new AbortController().signal,
  }
  const pending = guarded.run(() => SessionReadSource.resolve(input))
  await entered.promise
  input.targetSessionID = "ses_changed"
  input.offset = 9
  proceed.resolve()
  const result = await pending
  expect(observed).toMatchObject({ callerSessionID: "ses_reader", targetSessionID: "ses_shared", limit: 4, offset: 2 })
  expect(observed?.signal).toBe(input.signal)
  expect(result).toEqual(response)
  response.result.metadata.versions = [2]
  expect(result).toMatchObject({ result: { metadata: { versions: [1] } } })
  expect(await native.run(() => SessionReadSource.resolve(input))).toEqual({ kind: "native" })
  expect(() => guarded.run(() => SessionReadSource.register({ resolve: async () => ({ kind: "native" }) }))).toThrow(
    "before opening",
  )
})

test("a registered Session reader preserves owner refusal and cancellation without native fallback", async () => {
  const refusal = new Error("The original shared owner refused this read")
  const cancelled = new Error("The reader was cancelled while the owner resolved it")
  const abort = new AbortController()
  let mode: "refuse" | "cancel" = "refuse"
  let calls = 0
  await using runtime = await testRuntime({
    register() {
      SessionReadSource.register({
        async resolve() {
          calls++
          if (mode === "refuse") throw refusal
          abort.abort(cancelled)
          return { kind: "native" }
        },
      })
    },
  })
  const input = {
    callerSessionID: "ses_reader",
    targetSessionID: "ses_shared",
    limit: 1,
    offset: 0,
    signal: abort.signal,
  }
  await expect(runtime.run(() => SessionReadSource.resolve(input))).rejects.toBe(refusal)
  mode = "cancel"
  await expect(runtime.run(() => SessionReadSource.resolve(input))).rejects.toBe(cancelled)
  expect(calls).toBe(2)
  await expect(runtime.run(() => SessionReadSource.resolve(input))).rejects.toBe(cancelled)
  expect(calls).toBe(2)
})
