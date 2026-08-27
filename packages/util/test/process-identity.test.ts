import { describe, expect, test } from "bun:test"
import { processStartIdentity } from "../src/process-identity"

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
