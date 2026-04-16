import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { DaemonLogTail } from "../../src/daemon/log-tail"

describe("daemon.log-tail", () => {
  let filePath: string

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-log-tail-"))
    filePath = path.join(dir, "server.log")
  })

  afterEach(async () => {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true })
  })

  test("tailFile returns the requested trailing lines", async () => {
    await fs.writeFile(filePath, "a\nb\nc\nd\n", "utf8")
    const text = await DaemonLogTail.tailFile(filePath, 2)
    expect(text).toBe("c\nd")
  })

  test("tailFile returns empty string for missing file", async () => {
    const text = await DaemonLogTail.tailFile(filePath, 20)
    expect(text).toBe("")
  })
})
