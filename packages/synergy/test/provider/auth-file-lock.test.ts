import { expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"

test("provider credential locks serialize writers across worker processes", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-auth-lock-"))
  const output = path.join(home, "order.log")
  const fixture = path.join(import.meta.dirname, "fixtures", "auth-lock-worker.ts")
  const env = { ...process.env, SYNERGY_HOME: home }
  const first = Bun.spawn([process.execPath, "run", fixture, "shared", output, "first"], {
    env,
    stdout: "ignore",
    stderr: "pipe",
  })
  const readyDeadline = Date.now() + 5_000
  while ((await fs.readFile(output, "utf8").catch(() => "")) !== "first:start\n") {
    if (Date.now() >= readyDeadline) throw new Error("First credential-lock writer did not acquire the lock")
    await Bun.sleep(10)
  }
  const second = Bun.spawn([process.execPath, "run", fixture, "shared", output, "second"], {
    env,
    stdout: "ignore",
    stderr: "pipe",
  })

  try {
    const [firstCode, secondCode] = await Promise.all([first.exited, second.exited])
    expect(firstCode).toBe(0)
    expect(secondCode).toBe(0)
    const lines = (await fs.readFile(output, "utf8")).trim().split("\n")
    expect(lines).toEqual(["first:start", "first:end", "second:start", "second:end"])
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})
