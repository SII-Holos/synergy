import { afterEach, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../support/fixture"

const children: Bun.Subprocess<"ignore", "ignore", "pipe">[] = []

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill()
  }
  await Promise.all(children.map((child) => child.exited))
  children.length = 0
})

test("provider credential locks serialize writers across worker processes", async () => {
  await using home = await tmpdir()
  const output = path.join(home.path, "order.log")
  const fixture = path.join(import.meta.dirname, "fixtures", "auth-lock-worker.ts")
  const env = { ...process.env, SYNERGY_HOME: home.path, SYNERGY_TEST_HOME: home.path }

  function spawn(marker: "first" | "second") {
    const ready = Promise.withResolvers<void>()
    const child = Bun.spawn([process.execPath, "run", fixture, "shared", output, marker], {
      env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      ipc(message) {
        if (message === (marker === "first" ? "locked" : "attempting")) ready.resolve()
      },
    })
    children.push(child)
    const stderr = new Response(child.stderr).text()
    const exited = Promise.all([child.exited, stderr])
    return {
      child,
      exited,
      ready: Promise.race([
        ready.promise,
        exited.then(([code, error]) => {
          throw new Error(`${marker} credential-lock writer exited before readiness (${code}): ${error}`)
        }),
      ]),
    }
  }

  const first = spawn("first")
  await first.ready
  expect(await fs.readFile(output, "utf8")).toBe("first:start\n")
  const second = spawn("second")
  await second.ready
  first.child.send("release")

  const results = await Promise.all([first.exited, second.exited])
  for (const [code, stderr] of results) expect(code, stderr).toBe(0)
  const lines = (await fs.readFile(output, "utf8")).trim().split("\n")
  expect(lines).toEqual(["first:start", "first:end", "second:start", "second:end"])
}, 30_000)
