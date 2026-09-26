import { describe, expect, test } from "bun:test"
import { BrowserStagingLeasePool } from "../src/staging"

describe("BrowserStagingLeasePool", () => {
  test("keeps staged files through input assignment and bounds retained batches", async () => {
    const released: number[] = []
    const pool = new BrowserStagingLeasePool(2, 60_000)
    pool.retain(() => {
      released.push(1)
    })
    pool.retain(() => {
      released.push(2)
    })
    expect(released).toEqual([])

    pool.retain(() => {
      released.push(3)
    })
    await Promise.resolve()
    expect(released).toEqual([1])

    await pool.dispose()
    expect(released).toEqual([1, 2, 3])
  })

  test("reports cleanup failures that happened during lease eviction", async () => {
    const pool = new BrowserStagingLeasePool(1, 60_000)
    pool.retain(() => {
      throw new Error("cleanup failed")
    })
    pool.retain(() => {})
    await Promise.resolve()
    await expect(pool.dispose()).rejects.toThrow("Browser staging files could not be fully removed")
  })
})

test("releases a lease when its TTL timer fires", async () => {
  const released: number[] = []
  const pool = new BrowserStagingLeasePool(5, 10)
  pool.retain(() => {
    released.push(1)
  })
  await Bun.sleep(30)
  expect(released).toEqual([1])
  await pool.dispose()
})

test("ignores undefined cleanups", async () => {
  const pool = new BrowserStagingLeasePool(5, 10)
  pool.retain(undefined)
  await pool.dispose()
})
