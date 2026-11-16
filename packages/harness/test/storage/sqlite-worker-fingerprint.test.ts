import { afterAll, expect, spyOn, test } from "bun:test"
import * as crypto from "node:crypto"
import path from "node:path"
import { RuntimeContext } from "../../src/lifecycle/context"
import { ObservabilityConfig } from "../../src/observability/config"
import { ObservabilityMetrics } from "../../src/observability/metrics"
import { ObservabilityStore } from "../../src/observability/store"
import { StorageClosedError, StorageUnavailableError } from "../../src/storage/errors"
import { SqliteWorkerClient } from "../../src/storage/sqlite-worker-client"
import type { SqliteRequest, SqlValue } from "../../src/storage/sql-contract"
import { runtimeHome } from "../support/runtime-home"

const home = await runtimeHome()
const runtime = RuntimeContext.create(home.host, "oneshot")
let sequence = 0
const SELECT = "SELECT ? AS value"
type Metric = Parameters<typeof ObservabilityMetrics.record>[0]

afterAll(async () => {
  runtime.dispose()
  await home[Symbol.asyncDispose]()
})

async function withClient<T>(
  run: (client: SqliteWorkerClient) => Promise<T>,
  owner = runtime,
  root = home.host.root,
): Promise<T> {
  return owner.run(async () => {
    const client = new SqliteWorkerClient("writer")
    try {
      await ObservabilityMetrics.withForwarder(
        () => {},
        () => client.request({ action: "open", filename: path.join(root, `fingerprint-${++sequence}.sqlite`) }),
      )
      return await run(client)
    } finally {
      await ObservabilityMetrics.withForwarder(
        () => {},
        () => client.close(),
      )
    }
  })
}

async function query(client: SqliteWorkerClient, statement: string, values: SqlValue[] = []) {
  return (await client.request({ action: "query", statement, values })).rows
}

function memoCounts(client: SqliteWorkerClient) {
  const state = client as unknown as {
    sqlFingerprints: ReadonlyMap<unknown, unknown>
    sqlFingerprintBytes: number
  }
  return { entries: state.sqlFingerprints.size, payloadBytes: state.sqlFingerprintBytes }
}

function worker(client: SqliteWorkerClient) {
  return (client as unknown as { worker: Bun.Subprocess }).worker
}

function hashObserver() {
  const original = crypto.createHash
  return spyOn(crypto, "createHash").mockImplementation((algorithm, options) => original(algorithm, options))
}

function settled<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ ok: true, value }) as const,
    (error: unknown) => ({ ok: false, error }) as const,
  )
}

function paddedStatement(length: number, character: string) {
  const prefix = `${SELECT} /*`
  const suffix = "*/"
  return prefix + character.repeat(length - prefix.length - suffix.length) + suffix
}

test("identical SQL telemetry computes one fingerprint while both real queries retain their fresh values", () =>
  withClient(async (client) => {
    const recorded: Metric[] = []
    ObservabilityConfig.refresh({ observability: { enabled: false } })
    try {
      await ObservabilityMetrics.withForwarder(
        (input) => recorded.push(input),
        async () => {
          using hashes = hashObserver()
          const first = await query(client, SELECT, [1])
          const second = await query(client, SELECT, [9])
          expect(first).toEqual([{ value: 1n }])
          expect(second).toEqual([{ value: 9n }])
          expect(recorded.map((input) => input.labels)).toEqual([
            { role: "writer", fingerprint: "bc49ee9edb73e78e", status: "ok", maintenance: "none" },
            { role: "writer", fingerprint: "bc49ee9edb73e78e", status: "ok", maintenance: "none" },
          ])
          expect(hashes).toHaveBeenCalledTimes(1)
        },
      )
    } finally {
      ObservabilityConfig.refresh()
    }
  }))

test("SQL telemetry memo belongs to each client and Runtime while an interleaved owner keeps serving", async () => {
  await using otherHome = await runtimeHome()
  const otherRuntime = RuntimeContext.create(otherHome.host, "oneshot")
  try {
    await withClient((first) =>
      withClient((second) =>
        withClient(
          async (foreign) => {
            using hashes = hashObserver()
            const firstRows: Metric[] = []
            const otherRows: Metric[] = []
            await runtime.run(() =>
              ObservabilityMetrics.withForwarder(
                (input) => firstRows.push(input),
                async () => {
                  expect(await query(first, SELECT, [2])).toEqual([{ value: 2n }])
                  expect(await query(second, SELECT, [3])).toEqual([{ value: 3n }])
                  expect(await query(first, SELECT, [5])).toEqual([{ value: 5n }])
                },
              ),
            )
            await otherRuntime.run(() =>
              ObservabilityMetrics.withForwarder(
                (input) => otherRows.push(input),
                async () => {
                  expect(await query(foreign, SELECT, [7])).toEqual([{ value: 7n }])
                },
              ),
            )
            expect(hashes).toHaveBeenCalledTimes(3)
            expect(firstRows).toHaveLength(3)
            expect(otherRows).toHaveLength(1)
            await runtime.run(() =>
              ObservabilityMetrics.withForwarder(
                () => {},
                () => first.close(),
              ),
            )
            expect(memoCounts(first)).toEqual({ entries: 0, payloadBytes: 0 })
            await runtime.run(() =>
              ObservabilityMetrics.withForwarder(
                () => {},
                async () => {
                  expect(await query(second, SELECT, [11])).toEqual([{ value: 11n }])
                },
              ),
            )
            await otherRuntime.run(() =>
              ObservabilityMetrics.withForwarder(
                () => {},
                async () => {
                  expect(await query(foreign, SELECT, [13])).toEqual([{ value: 13n }])
                },
              ),
            )
            expect(hashes).toHaveBeenCalledTimes(3)
          },
          otherRuntime,
          otherHome.host.root,
        ),
      ),
    )
  } finally {
    otherRuntime.dispose()
  }
})

test("129 real statement texts retain 128 entries and a recent hit survives LRU pressure", () =>
  withClient((client) =>
    ObservabilityMetrics.withForwarder(
      () => {},
      async () => {
        using hashes = hashObserver()
        const statement = (index: number) => `${SELECT} /* fingerprint-${index} */`
        for (let index = 0; index < 128; index++) {
          expect(await query(client, statement(index), [index])).toEqual([{ value: BigInt(index) }])
        }
        expect(hashes).toHaveBeenCalledTimes(128)
        expect(memoCounts(client).entries).toBe(128)
        expect(memoCounts(client).payloadBytes).toBeLessThanOrEqual(128 * 1024)
        expect(await query(client, statement(0), [200])).toEqual([{ value: 200n }])
        expect(hashes).toHaveBeenCalledTimes(128)
        expect(await query(client, statement(128), [201])).toEqual([{ value: 201n }])
        expect(hashes).toHaveBeenCalledTimes(129)
        expect(memoCounts(client).entries).toBe(128)
        expect(await query(client, statement(0), [202])).toEqual([{ value: 202n }])
        expect(await query(client, statement(128), [203])).toEqual([{ value: 203n }])
        expect(hashes).toHaveBeenCalledTimes(129)
        expect(await query(client, statement(1), [204])).toEqual([{ value: 204n }])
        expect(hashes).toHaveBeenCalledTimes(130)
        expect(await query(client, statement(0), [205])).toEqual([{ value: 205n }])
        expect(hashes).toHaveBeenCalledTimes(130)
        expect(memoCounts(client).entries).toBe(128)
      },
    ),
  ))

test("UTF16 payload eviction and exact-size admission leave oversized statement text unretained", () =>
  withClient((client) =>
    ObservabilityMetrics.withForwarder(
      () => {},
      async () => {
        using hashes = hashObserver()
        const first = paddedStatement(40_000, "é")
        const second = paddedStatement(40_000, "λ")
        expect(await query(client, first, [1])).toEqual([{ value: 1n }])
        expect(await query(client, first, [2])).toEqual([{ value: 2n }])
        expect(hashes).toHaveBeenCalledTimes(1)
        expect(memoCounts(client)).toEqual({ entries: 1, payloadBytes: 80_032 })
        expect(await query(client, second, [3])).toEqual([{ value: 3n }])
        expect(await query(client, second, [4])).toEqual([{ value: 4n }])
        expect(hashes).toHaveBeenCalledTimes(2)
        expect(memoCounts(client)).toEqual({ entries: 1, payloadBytes: 80_032 })
        expect(await query(client, first, [5])).toEqual([{ value: 5n }])
        expect(hashes).toHaveBeenCalledTimes(3)
        const exact = paddedStatement(65_520, "c")
        const oversized = paddedStatement(65_521, "d")
        expect(await query(client, exact, [6])).toEqual([{ value: 6n }])
        expect(await query(client, exact, [7])).toEqual([{ value: 7n }])
        expect(hashes).toHaveBeenCalledTimes(4)
        expect(memoCounts(client)).toEqual({ entries: 1, payloadBytes: 128 * 1024 })
        expect(await query(client, oversized, [8])).toEqual([{ value: 8n }])
        expect(await query(client, oversized, [9])).toEqual([{ value: 9n }])
        expect(hashes).toHaveBeenCalledTimes(6)
        expect(memoCounts(client)).toEqual({ entries: 1, payloadBytes: 128 * 1024 })
        expect(await query(client, exact, [10])).toEqual([{ value: 10n }])
        expect(hashes).toHaveBeenCalledTimes(6)
      },
    ),
  ))

test("normalization remains private and a memoized failed statement executes again against current SQLite state", () =>
  withClient((client) => {
    const recorded: Metric[] = []
    return ObservabilityMetrics.withForwarder(
      (input) => recorded.push(input),
      async () => {
        using hashes = hashObserver()
        const first = "SELECT 'private''literal-A' AS value, 123 AS number"
        const second = "SELECT 'private''literal-B' AS value, 456 AS number"
        expect(await query(client, first)).toEqual([{ value: "private'literal-A", number: 123n }])
        expect(await query(client, second)).toEqual([{ value: "private'literal-B", number: 456n }])
        expect(await query(client, first)).toEqual([{ value: "private'literal-A", number: 123n }])
        expect(hashes).toHaveBeenCalledTimes(2)
        const previouslyMissing = "SELECT ? AS value FROM missing_fingerprint_table"
        for (const value of ["private-bound-A", "private-bound-B"]) {
          const result = await settled(query(client, previouslyMissing, [value]))
          expect(result.ok).toBe(false)
          if (result.ok) throw new Error("Expected the real SQLite missing-table failure")
          expect(result.error).toBeInstanceOf(Error)
        }
        expect(hashes).toHaveBeenCalledTimes(3)
        await query(client, "CREATE TABLE missing_fingerprint_table(value INTEGER)")
        await query(client, "INSERT INTO missing_fingerprint_table VALUES (?)", [1])
        expect(await query(client, previouslyMissing, ["private-bound-C"])).toEqual([{ value: "private-bound-C" }])
        expect(hashes).toHaveBeenCalledTimes(5)
        expect(recorded).toHaveLength(8)
        expect(recorded.slice(0, 3).map((input) => input.labels)).toEqual(
          Array.from({ length: 3 }, () => ({
            role: "writer",
            fingerprint: "a2cbeadb3ca311d0",
            status: "ok",
            maintenance: "none",
          })),
        )
        expect(recorded.slice(3, 5).map((input) => ({ labels: input.labels, sampleRate: input.sampleRate }))).toEqual(
          Array.from({ length: 2 }, () => ({
            labels: { role: "writer", fingerprint: "af8c3219bd1f9b22", status: "error", maintenance: "none" },
            sampleRate: 1,
          })),
        )
        expect(recorded[7]?.labels).toEqual({
          role: "writer",
          fingerprint: "af8c3219bd1f9b22",
          status: "ok",
          maintenance: "none",
        })
        const output = JSON.stringify(recorded)
        for (const privateText of [
          first,
          second,
          previouslyMissing,
          "private'literal-A",
          "private'literal-B",
          "private-bound-",
          "missing_fingerprint_table",
        ]) {
          expect(output).not.toContain(privateText)
        }
      },
    )
  }))

test("the original sampler still drops fast success and retains errors and slow success", () =>
  withClient(async (client) => {
    const inserted: Parameters<typeof ObservabilityStore.insertMetric>[0][] = []
    ObservabilityConfig.refresh({ observability: { enabled: true } })
    try {
      using persistence = spyOn(ObservabilityStore, "insertMetric").mockImplementation((input) => {
        inserted.push(input)
      })
      using random = spyOn(Math, "random").mockReturnValue(1)
      const initial = performance.now()
      let current = initial
      using clock = spyOn(performance, "now").mockImplementation(() => current)
      const outgoing = worker(client) as unknown as { send(message: SqliteRequest): void }
      const deliver = outgoing.send.bind(outgoing)
      const slow = `${SELECT} /* observed-slow */`
      using send = spyOn(outgoing, "send").mockImplementation((message) => {
        if (message.statement === slow) current = initial + 1001
        deliver(message)
      })
      expect(await query(client, SELECT, [1])).toEqual([{ value: 1n }])
      expect(inserted).toEqual([])
      expect(random).toHaveBeenCalledTimes(1)
      const failure = await settled(query(client, "SELECT value FROM missing_sampling_table"))
      expect(failure.ok).toBe(false)
      if (failure.ok) throw new Error("Expected a real SQLite missing-table failure")
      expect(failure.error).toBeInstanceOf(Error)
      expect(inserted).toHaveLength(1)
      expect(inserted[0]?.labels?.status).toBe("error")
      expect(inserted[0]?.sampleRate).toBe(1)
      expect(random).toHaveBeenCalledTimes(1)
      expect(await query(client, slow, [2])).toEqual([{ value: 2n }])
      expect(inserted).toHaveLength(2)
      expect(inserted[1]?.labels?.status).toBe("ok")
      expect(inserted[1]?.sampleRate).toBe(1)
      expect(inserted[1]?.value).toBeCloseTo(1001, 6)
      expect(random).toHaveBeenCalledTimes(1)
    } finally {
      ObservabilityConfig.refresh()
    }
  }))

test("ordinary client close clears retained SQL and preserves the closed-request error", () =>
  withClient((client) =>
    ObservabilityMetrics.withForwarder(
      () => {},
      async () => {
        expect(await query(client, SELECT, [1])).toEqual([{ value: 1n }])
        expect(memoCounts(client).entries).toBe(1)
        await client.close()
        expect(memoCounts(client)).toEqual({ entries: 0, payloadBytes: 0 })
        expect(client.status).toBe("closed")
        expect(client.unavailable).toBeUndefined()
        const result = await settled(query(client, SELECT, [2]))
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error("Expected a closed client")
        expect(result.error).toBeInstanceOf(StorageClosedError)
      },
    ),
  ))

test("a terminal IPC failure clears retained SQL before reporting unavailability", () =>
  withClient((client) =>
    ObservabilityMetrics.withForwarder(
      () => {},
      async () => {
        expect(await query(client, SELECT, [1])).toEqual([{ value: 1n }])
        const unavailable: Array<{ error: Error; memo: ReturnType<typeof memoCounts> }> = []
        const unsubscribe = client.onUnavailable((error) => unavailable.push({ error, memo: memoCounts(client) }))
        try {
          const outgoing = worker(client) as unknown as { send(message: SqliteRequest): void }
          const error = Object.assign(new Error("fixture IPC closed"), { code: "ERR_IPC_CHANNEL_CLOSED" })
          using send = spyOn(outgoing, "send").mockImplementation(() => {
            throw error
          })
          const result = await settled(query(client, `${SELECT} /* terminal */`, [2]))
          expect(result.ok).toBe(false)
          if (result.ok) throw new Error("Expected terminal unavailability")
          expect(result.error).toBeInstanceOf(StorageUnavailableError)
          if (!(result.error instanceof StorageUnavailableError)) throw result.error
          expect(unavailable).toEqual([{ error: result.error, memo: { entries: 0, payloadBytes: 0 } }])
          expect(client.unavailable).toBe(result.error)
          expect(memoCounts(client)).toEqual({ entries: 0, payloadBytes: 0 })
        } finally {
          unsubscribe()
        }
      },
    ),
  ))

test("the original worker exit callback clears retained SQL and keeps the terminal fence", () =>
  withClient((client) =>
    ObservabilityMetrics.withForwarder(
      () => {},
      async () => {
        expect(await query(client, SELECT, [1])).toEqual([{ value: 1n }])
        expect(memoCounts(client).entries).toBe(1)
        const terminal = Promise.withResolvers<{ error: Error; memo: ReturnType<typeof memoCounts> }>()
        const unsubscribe = client.onUnavailable((error) => terminal.resolve({ error, memo: memoCounts(client) }))
        const process = worker(client)
        try {
          process.disconnect()
          const observed = await terminal.promise
          const original = observed.error
          await process.exited
          expect(original).toBeInstanceOf(StorageUnavailableError)
          expect(observed.memo).toEqual({ entries: 0, payloadBytes: 0 })
          expect(memoCounts(client)).toEqual({ entries: 0, payloadBytes: 0 })
          const result = await settled(query(client, SELECT, [2]))
          expect(result.ok).toBe(false)
          if (result.ok) throw new Error("Expected the original terminal error")
          expect(result.error).toBe(original)
          expect(client.unavailable).toBe(original)
        } finally {
          unsubscribe()
        }
      },
    ),
  ))

test("an exit during original close clears SQL before settling that close request", () =>
  withClient((client) =>
    ObservabilityMetrics.withForwarder(
      () => {},
      async () => {
        expect(await query(client, SELECT, [1])).toEqual([{ value: 1n }])
        const snapshots: Array<{ status: unknown; memo: ReturnType<typeof memoCounts> }> = []
        ObservabilityConfig.refresh({ observability: { enabled: false } })
        try {
          const process = worker(client)
          const outgoing = process as unknown as { send(message: SqliteRequest): void }
          const deliver = outgoing.send.bind(outgoing)
          using send = spyOn(outgoing, "send").mockImplementation((message) => {
            if (message.action === "close") process.disconnect()
            else deliver(message)
          })
          await ObservabilityMetrics.withForwarder(
            (input) => {
              if (input.name === "storage.sql.duration" && input.labels?.fingerprint === "close") {
                snapshots.push({ status: input.labels.status, memo: memoCounts(client) })
              }
            },
            () => client.close(),
          )
          expect(snapshots).toEqual([{ status: "error", memo: { entries: 0, payloadBytes: 0 } }])
          expect(memoCounts(client)).toEqual({ entries: 0, payloadBytes: 0 })
          expect(client.status).toBe("closed")
          expect(client.unavailable).toBeUndefined()
        } finally {
          ObservabilityConfig.refresh()
        }
      },
    ),
  ))
