import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { SqliteDriver } from "../../src/storage/sqlite-driver"
import { StorageBusyError, StorageUnavailableError } from "../../src/storage/errors"
import { StorageBudgets } from "../../src/storage/budgets"
import type { SqliteRequest } from "../../src/storage/sql-contract"

const OWED_QUERY = "SELECT 1 AS value"
// Occupies the worker's event loop, so a capped wall deadline fires while the
// statement is still running and the worker itself is still healthy.
const SLOW_QUERY =
  "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 1000000) SELECT 1 AS value FROM (SELECT count(*) FROM c)"

const roots: string[] = []
const drivers: SqliteDriver[] = []
const interceptions: Array<() => void> = []

afterEach(async () => {
  for (const restore of interceptions.splice(0)) restore()
  await Promise.all(drivers.splice(0).map((driver) => driver.close().catch(() => {})))
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function openDriver() {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "storage-suspend-"))
  roots.push(root)
  const driver = await SqliteDriver.open(path.join(root, "agent.sqlite"))
  drivers.push(driver)
  return driver
}

function internals(driver: SqliteDriver) {
  return driver as unknown as { closed: boolean; queuedBytes: number; worker: Bun.Subprocess }
}

// Intercepts the driver's outgoing requests. Every test must end with real
// delivery restored, because teardown sends a closing request of its own.
function interceptSend(
  driver: SqliteDriver,
  handler: (message: SqliteRequest, deliver: (override?: SqliteRequest) => void) => void,
) {
  const worker = internals(driver).worker as unknown as { send(message: SqliteRequest): void }
  const deliver = worker.send.bind(worker)
  worker.send = (message) => handler(message, (override) => deliver(override ?? message))
  interceptions.push(() => {
    worker.send = deliver
  })
}

// Compresses the wall-clock delays a suspended host would consume, so a test
// reaches the deadline review in milliseconds instead of the production budget.
function capWallClockDeadlines() {
  const realTimeout: typeof setTimeout = globalThis.setTimeout
  const armed: number[] = []
  const spy = spyOn(globalThis, "setTimeout").mockImplementation(
    new Proxy(realTimeout, {
      apply(target, receiver, args) {
        if (typeof args[1] === "number" && args[1] >= 30_000) {
          armed.push(args[1])
          return Reflect.apply(target, receiver, [args[0], 10, ...args.slice(2)])
        }
        return Reflect.apply(target, receiver, args)
      },
    }) as typeof setTimeout,
  )
  return {
    armed,
    [Symbol.dispose]() {
      spy.mockRestore()
    },
  }
}

// Stands in for a host suspend: wall-clock timers keep firing while the monotonic
// clock the deadline is measured against does not advance.
function suspendMonotonicClock(initial = 1_000) {
  const clock = { current: initial }
  const spy = spyOn(performance, "now").mockImplementation(() => clock.current)
  return {
    clock,
    [Symbol.dispose]() {
      spy.mockRestore()
    },
  }
}

async function failure(task: Promise<unknown>) {
  return task.then(
    () => {
      throw new Error("Expected the operation to fail")
    },
    (error: unknown) => error,
  )
}

// The probe count is bounded by the ceiling-to-probe ratio rather than a fixed
// constant, because a probe timeout is a busy signal, not a death signal.
const budgets = StorageBudgets.current()

describe("SQLite worker deadline across host suspension", () => {
  test("a wall-clock deadline that fires while the monotonic budget stands does not kill the worker", async () => {
    using deadlines = capWallClockDeadlines()
    using _clock = suspendMonotonicClock()
    const driver = await openDriver()
    interceptSend(driver, (message, deliver) =>
      deliver(
        message.action === "query" && message.statement === OWED_QUERY
          ? { ...message, statement: SLOW_QUERY }
          : message,
      ),
    )

    expect(await driver.query(OWED_QUERY)).toEqual([{ value: 1n }])
    expect(deadlines.armed.length).toBeGreaterThan(0)
    expect(internals(driver).closed).toBe(false)
    expect(internals(driver).worker.killed).toBe(false)
    expect(await driver.query("SELECT 2 AS value")).toEqual([{ value: 2n }])
  })

  test("a worker that never answers any request escalates once and rejects new work", async () => {
    using _deadlines = capWallClockDeadlines()
    using clock = suspendMonotonicClock()
    const driver = await openDriver()
    let probes = 0
    interceptSend(driver, (message) => {
      if (message.action === "ping") probes++
      // Swallow every request, probes included, and let the monotonic clock run
      // past each budget so the terminal path is reached deterministically.
      clock.clock.current += 60_000
    })
    const unavailable: Error[] = []
    driver.onUnavailable((error) => unavailable.push(error))

    const first = await failure(driver.query(OWED_QUERY))
    expect(first).toBeInstanceOf(StorageUnavailableError)
    expect(unavailable).toHaveLength(1)
    // The worker is probed until its silence outlasts the ceiling rather than
    // being declared dead after a fixed number of unanswered probes, so the
    // count is bounded by the ceiling-to-probe-timeout ratio instead of a
    // constant.
    expect(probes).toBeGreaterThan(1)
    expect(probes).toBeLessThanOrEqual(Math.ceil(budgets.hardCeilingMs / budgets.probeTimeoutMs) + 1)
    expect(internals(driver).closed).toBe(true)
    await internals(driver).worker.exited
    expect(internals(driver).worker.killed).toBe(true)

    const second = await failure(driver.query("SELECT 2 AS value"))
    expect(second).toBe(first)
    expect(unavailable).toHaveLength(1)
  })

  test("a worker that answers the liveness probe survives while the request keeps its deadline", async () => {
    using _deadlines = capWallClockDeadlines()
    using clock = suspendMonotonicClock()
    const driver = await openDriver()
    let probes = 0
    interceptSend(driver, (message, deliver) => {
      if (message.action === "ping") {
        probes++
        return deliver()
      }
      // One statement outlives its budget while the worker stays responsive.
      clock.clock.current += 30_000
    })

    expect(await failure(driver.query(OWED_QUERY))).toBeInstanceOf(StorageBusyError)
    expect(probes).toBe(1)
    expect(internals(driver).closed).toBe(false)
    expect(internals(driver).worker.killed).toBe(false)

    const worker = internals(driver).worker
    expect(worker.killed).toBe(false)
    for (const restore of interceptions.splice(0)) restore()
    expect(await driver.query("SELECT 2 AS value")).toEqual([{ value: 2n }])
  })

  test("an ordinary query, transaction and close still work end to end", async () => {
    const driver = await openDriver()
    expect(await driver.query(OWED_QUERY)).toEqual([{ value: 1n }])
    expect(await driver.transaction((tx) => tx.query("SELECT 2 AS value"))).toEqual([{ value: 2n }])
    expect(internals(driver).closed).toBe(false)
    const worker = internals(driver).worker
    await driver.close()
    expect(worker.killed).toBe(true)
  })
})
