import { describe, expect, spyOn, test } from "bun:test"
import { RolloutCall } from "../../src/session/rollout/call"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { RolloutTransport } from "../../src/session/rollout/transport"
import { Storage } from "../../src/storage/storage"

function input() {
  const id = crypto.randomUUID()
  return {
    owner: { kind: "operation" as const, scopeID: "test", operationID: id },
    runID: id,
    purpose: "test",
    model: { providerID: "test", modelID: "test", sdk: "test", pricing: null },
    request: { messages: [] },
  }
}

describe("rollout call stream", () => {
  test("rejects later calls in a run after recording fails even when storage recovers", async () => {
    const args = input()
    {
      using write = spyOn(Storage, "writeBinary").mockRejectedValue(new Error("disk full"))
      await expect(
        RolloutCall.stream(args, async () => {
          throw new Error("must not execute")
        }),
      ).rejects.toMatchObject({ name: "RolloutRecordingError" })
    }
    let started = false
    await expect(
      RolloutCall.stream(args, async () => {
        started = true
        return { fullStream: (async function* () {})(), usage: Promise.resolve(undefined), async dispose() {} }
      }),
    ).rejects.toMatchObject({ name: "RolloutRecordingError" })
    expect(started).toBe(false)
    expect((await RolloutLedger.getRun(args.owner, args.runID)).recording).toBe("failed")
  })

  test("does not classify an SDK abort event as successful completion", async () => {
    const args = input()
    const stream = await RolloutCall.stream(args, async () => ({
      fullStream: (async function* () {
        yield { type: "abort" as const }
      })(),
      usage: Promise.resolve(undefined),
      async dispose() {},
    }))
    for await (const event of stream.fullStream) void event
    const [call] = await RolloutLedger.calls(args.owner, args.runID)
    expect(call.status).toBe("cancelled")
  })

  test("keeps recording failure authoritative when stream disposal also fails", async () => {
    const original = Storage.writeBinary.bind(Storage)
    let writes = 0
    using write = spyOn(Storage, "writeBinary").mockImplementation(async (key, bytes) => {
      if (++writes > 1) throw new Error("disk full")
      return original(key, bytes)
    })
    const stream = await RolloutCall.stream(input(), async () => ({
      fullStream: (async function* () {
        yield { type: "text-delta" as const, id: "text", text: "x".repeat(RolloutArtifact.CHUNK_BYTES) }
      })(),
      usage: Promise.resolve(undefined),
      async dispose() {
        throw new Error("cleanup failed")
      },
    }))
    await expect(
      (async () => {
        for await (const event of stream.fullStream) void event
      })(),
    ).rejects.toMatchObject({ name: "RolloutRecordingError" })
  })

  test("aborts the owner and stops the stream after response persistence fails", async () => {
    const args = input()
    const original = Storage.writeBinary.bind(Storage)
    let writes = 0
    let produced = 0
    let aborted = false
    let disposed = false
    using write = spyOn(Storage, "writeBinary").mockImplementation(async (key, bytes) => {
      if (++writes > 1) throw new Error("disk full")
      return original(key, bytes)
    })
    const stream = await RolloutCall.stream(
      args,
      async () => ({
        fullStream: (async function* () {
          for (let index = 0; index < 3; index++) {
            produced++
            yield { type: "text-delta" as const, id: "text", text: "x".repeat(RolloutArtifact.CHUNK_BYTES) }
          }
        })(),
        usage: Promise.resolve(undefined),
        async dispose() {
          disposed = true
        },
      }),
      () => {
        aborted = true
      },
    )
    await expect(
      (async () => {
        for await (const event of stream.fullStream) void event
      })(),
    ).rejects.toThrow()
    expect(produced).toBe(1)
    expect(aborted).toBe(true)
    expect(disposed).toBe(true)
  })

  test("records intent before starting and commits consumed response with SDK usage", async () => {
    const args = input()
    let disposed = false
    const stream = await RolloutCall.stream(args, async () => {
      expect((await RolloutLedger.calls(args.owner, args.runID))[0].status).toBe("running")
      return {
        fullStream: (async function* () {
          yield { type: "text-delta" as const, id: "text", text: "hello" }
        })(),
        usage: Promise.resolve({ inputTokens: 5, outputTokens: 1, totalTokens: 6 }),
        async dispose() {
          disposed = true
        },
      }
    })
    for await (const event of stream.fullStream) expect(event.type).toBe("text-delta")
    await stream.dispose()
    const [call] = await RolloutLedger.calls(args.owner, args.runID)
    expect(call.status).toBe("completed")
    expect(call.sdkUsage).toEqual({ inputTokens: 5, outputTokens: 1, totalTokens: 6 })
    expect(call.transportCaptured).toBe(false)
    expect(disposed).toBe(true)
    const chunks: Uint8Array[] = []
    for await (const chunk of RolloutArtifact.read(args.owner, call.response!.id)) chunks.push(chunk)
    expect(JSON.parse(Buffer.concat(chunks).toString())).toMatchObject({ type: "text-delta", text: "hello" })
  })

  test("never starts inference when request recording fails", async () => {
    let started = false
    using write = spyOn(Storage, "writeBinary").mockRejectedValue(new Error("disk full"))
    await expect(
      RolloutCall.stream(input(), async () => {
        started = true
        throw new Error("must not start")
      }),
    ).rejects.toThrow()
    expect(started).toBe(false)
  })

  test("disposal without consumption preserves a cancelled call", async () => {
    const args = input()
    const stream = await RolloutCall.stream(args, async () => ({
      fullStream: (async function* () {})(),
      usage: Promise.resolve(undefined),
      async dispose() {},
    }))
    await stream.dispose()
    const [call] = await RolloutLedger.calls(args.owner, args.runID)
    expect(call.status).toBe("cancelled")
    expect(call.response?.status).toBe("partial")
    expect(call.sdkUsage).toBeNull()
  })
})

describe("rollout non-streaming calls", () => {
  test("commits actual transport and result before returning", async () => {
    const args = input()
    const result = await RolloutCall.execute(args, async () => {
      expect((await RolloutLedger.calls(args.owner, args.runID))[0].status).toBe("running")
      const response = await RolloutTransport.fetch(
        async (request) => {
          expect(await new Response((request as Request).body).text()).toBe('{"input":"source"}')
          return Response.json({ summary: "done", usage: { input: 3 } })
        },
        "https://provider.test/compact",
        { method: "POST", body: '{"input":"source"}' },
      )
      const value = await response.json()
      return { value: value.summary as string, response: value, usage: value.usage }
    })
    expect(result).toBe("done")
    const [call] = await RolloutLedger.calls(args.owner, args.runID)
    expect(call.status).toBe("completed")
    expect(call.transportCaptured).toBe(true)
    expect(call.sdkUsage).toEqual({ input: 3 })
    const attempts = await RolloutLedger.attempts(args.owner, args.runID, call.id)
    expect(attempts).toHaveLength(1)
    expect(attempts[0].status).toBe("completed")
  })

  test("does not run an operation after intent persistence fails", async () => {
    const args = input()
    let started = false
    let stopped = false
    using write = spyOn(Storage, "writeBinary").mockRejectedValue(new Error("disk full"))
    await expect(
      RolloutCall.execute(
        args,
        async () => {
          started = true
          return { value: 1, response: { result: 1 } }
        },
        () => {
          stopped = true
        },
      ),
    ).rejects.toMatchObject({ name: "RolloutRecordingError" })
    expect(started).toBe(false)
    expect(stopped).toBe(true)
    expect((await RolloutLedger.getRun(args.owner, args.runID)).recording).toBe("failed")
  })

  test("records provider failure and preserves the original error", async () => {
    const args = input()
    const failure = new Error("provider unavailable")
    await expect(
      RolloutCall.execute(args, async () => {
        throw failure
      }),
    ).rejects.toBe(failure)
    const [call] = await RolloutLedger.calls(args.owner, args.runID)
    expect(call.status).toBe("failed")
    expect(call.error).toBe("provider unavailable")
    expect(call.sdkUsage).toBeNull()
  })
})

test("non-streaming response commit failure aborts the owner and closes run admission", async () => {
  const args = input()
  const original = Storage.writeBinary.bind(Storage)
  let returned = false
  let aborted = false
  using write = spyOn(Storage, "writeBinary").mockImplementation(async (key, bytes) => {
    if (returned) throw new Error("disk full")
    return original(key, bytes)
  })
  await expect(
    RolloutCall.execute(
      args,
      async () => {
        returned = true
        return { value: 1, response: { result: 1 } }
      },
      () => {
        aborted = true
      },
    ),
  ).rejects.toMatchObject({ name: "RolloutRecordingError" })
  expect(aborted).toBe(true)
  expect((await RolloutLedger.getRun(args.owner, args.runID)).recording).toBe("failed")
})

test("transport recorder joins concurrent finishes while draining accepted writes", async () => {
  const { RolloutTransportRecorder } = await import("../../src/session/rollout/transport-recorder")
  const args = input()
  const call = await RolloutLedger.beginCall(args)
  const recorder = RolloutTransportRecorder.create(call)
  const attemptID = crypto.randomUUID()
  await recorder.emit({
    type: "attempt-start",
    attemptID,
    url: "https://example.test",
    method: "POST",
    mediaType: "text/plain",
  })
  await recorder.emit({ type: "response", attemptID, status: 200, mediaType: "text/plain", headers: {} })
  const writing = recorder.emit({
    type: "chunk",
    attemptID,
    channel: "response",
    data: new TextEncoder().encode("partial response"),
  })
  const first = recorder.finish()
  const second = recorder.finish()
  expect(first).toBe(second)
  await writing
  expect(await first).toBe(false)
  await expect(
    recorder.emit({ type: "body-end", attemptID, channel: "response", complete: true }),
  ).rejects.toMatchObject({ name: "RolloutRecordingError" })
  const [attempt] = await RolloutLedger.attempts(args.owner, args.runID, call.id)
  expect(attempt.status).toBe("interrupted")
  expect(attempt.response?.status).toBe("partial")
})

test("concurrent disposal waits for an in-flight response checkpoint", async () => {
  const args = input()
  const writing = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const original = RolloutLedger.checkpointCall.bind(RolloutLedger)
  let checkpoints = 0
  let disposals = 0
  using checkpoint = spyOn(RolloutLedger, "checkpointCall").mockImplementation(async (...parameters) => {
    if (++checkpoints === 2) {
      writing.resolve()
      await release.promise
    }
    return original(...parameters)
  })
  const stream = await RolloutCall.stream(args, async () => ({
    fullStream: (async function* () {
      yield { type: "text-delta" as const, id: "text", text: "x".repeat(RolloutArtifact.CHUNK_BYTES) }
    })(),
    usage: Promise.resolve(undefined),
    async dispose() {
      disposals++
    },
  }))
  const iterator = stream.fullStream[Symbol.asyncIterator]()
  const reading = iterator.next()
  await writing.promise
  let disposed = false
  const first = stream.dispose().then(() => {
    disposed = true
  })
  const second = stream.dispose()
  try {
    await Promise.resolve()
    expect(disposed).toBe(false)
    expect((await RolloutLedger.calls(args.owner, args.runID))[0].status).toBe("running")
  } finally {
    release.resolve()
    await Promise.all([first, second, reading])
  }
  expect(disposals).toBe(1)
  const [call] = await RolloutLedger.calls(args.owner, args.runID)
  expect(call.status).toBe("cancelled")
  expect(call.response?.status).toBe("partial")
  expect(call.response?.bytes).toBeGreaterThanOrEqual(RolloutArtifact.CHUNK_BYTES)
})
