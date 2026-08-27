import { describe, expect, test } from "bun:test"
import { processStartIdentity, ticksToEpochMs, wmicCreationDateToEpochMs } from "../src/process-identity"

describe("processStartIdentity", () => {
  test("returns a stable identity for the current process", async () => {
    const first = await processStartIdentity(process.pid)
    const second = await processStartIdentity(process.pid)
    expect(first).toBeDefined()
    expect(second).toBe(first)
  })

  test("encodes the platform in the identity", async () => {
    const identity = await processStartIdentity(process.pid)
    const prefix = process.platform === "linux" ? "linux:" : process.platform === "win32" ? "windows:" : "unix:"
    expect(identity).toStartWith(prefix)
  })

  test("returns undefined for a process that cannot be inspected", async () => {
    expect(await processStartIdentity(-1)).toBeUndefined()
  })
})

describe("Windows start-time encoding", () => {
  // WMIC (local wall clock + UTC offset) and the PowerShell fallback (.NET
  // ticks) must produce the same epoch-millisecond identity for the same
  // instant, or a live owner looks like a recycled pid when a later query
  // takes the other path.
  test("wmic CreationDate and .NET ticks encode 2020-01-01T00:00:00Z identically", () => {
    expect(wmicCreationDateToEpochMs("20200101080000.000000+480")).toBe(1_577_836_800_000)
    expect(ticksToEpochMs("637134336000000000")).toBe(1_577_836_800_000)
  })

  test("rejects malformed inputs", () => {
    expect(wmicCreationDateToEpochMs("not-a-date")).toBeUndefined()
    expect(wmicCreationDateToEpochMs("20200101080000.000000")).toBeUndefined()
    expect(ticksToEpochMs("abc")).toBeUndefined()
  })
})
