import { expect, jest, spyOn, test } from "bun:test"
import { LibraryDB, closeDB } from "../src/database"
import { testRuntime } from "./support/runtime"

test("closing one Library database cancels its maintenance while another keeps checkpointing", async () => {
  await using left = await testRuntime()
  await using right = await testRuntime()
  left.run(closeDB)
  right.run(closeDB)
  jest.useFakeTimers()
  try {
    const a = left.run(() => LibraryDB.connection())
    const b = right.run(() => LibraryDB.connection())
    using leftQueries = spyOn(a, "exec")
    using rightQueries = spyOn(b, "exec")
    jest.advanceTimersByTime(300_000)
    expect(leftQueries).toHaveBeenCalledWith("PRAGMA wal_checkpoint(TRUNCATE)")
    expect(rightQueries).toHaveBeenCalledWith("PRAGMA wal_checkpoint(TRUNCATE)")
    leftQueries.mockClear()
    rightQueries.mockClear()
    left.run(closeDB)
    left.run(closeDB)
    jest.advanceTimersByTime(300_000)
    expect(leftQueries).not.toHaveBeenCalled()
    expect(rightQueries).toHaveBeenCalledTimes(1)
    expect(right.run(() => b.query("SELECT 1 AS value").get())).toEqual({ value: 1 })
  } finally {
    left.run(closeDB)
    right.run(closeDB)
    jest.useRealTimers()
  }
})
