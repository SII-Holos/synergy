import { expect, test } from "bun:test"
import { NativePty } from "../../src/process/native-pty"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import path from "node:path"
import { once } from "node:events"

test("a paused PTY consumer bounds buffering, then drains the complete native output", async () => {
  await using directory = await tmpdir()
  const done = path.join(directory.path, "done")
  const child = NativePty.spawn({
    command: process.execPath,
    args: [
      "-e",
      `process.stdout.write(Buffer.alloc(8 * 1024 * 1024, 120), async () => { await Bun.write(${JSON.stringify(done)}, "done"); process.exit(0) })`,
    ],
    cwd: directory.path,
    env: { PATH: process.env.PATH ?? "", HOME: directory.path },
  })
  try {
    const deadline = Date.now() + 5000
    while (child.stdout.readableLength < 64 * 1024) {
      if (Date.now() > deadline) throw new Error("PTY output did not arrive")
      await Bun.sleep(5)
    }
    expect(child.stdout.readableLength).toBeLessThanOrEqual(72 * 1024)
    expect(await Bun.file(done).exists()).toBe(false)
    let length = 0
    for await (const chunk of child.stdout) length += Buffer.byteLength(chunk)
    expect(length).toBe(8 * 1024 * 1024)
    expect(await child.exited).toBe(0)
    expect(await Bun.file(done).text()).toBe("done")
  } finally {
    child.kill()
    child.close()
  }
}, 30_000)

test("PTY launch preserves argv, explicit environment and the native working directory", async () => {
  await using directory = await tmpdir()
  const argument = "spaces ' quotes \" and 中文"
  const child = NativePty.spawn({
    command: process.execPath,
    args: [
      "-e",
      "console.log(JSON.stringify({ arg: process.argv[1], value: process.env.PTY_VALUE, cwd: process.cwd(), inherited: process.env.SYNERGY_TEST_HOME }))",
      argument,
    ],
    cwd: directory.path,
    env: { PATH: process.env.PATH ?? "", HOME: directory.path, PTY_VALUE: "explicit" },
  })
  try {
    let output = ""
    child.stdout.setEncoding("utf8")
    for await (const chunk of child.stdout) output += chunk
    expect(await child.exited).toBe(0)
    expect(JSON.parse(output.trim())).toEqual({ arg: argument, value: "explicit", cwd: directory.path })
  } finally {
    child.close()
  }
})

test("PTY rejects invalid launch and oversized input without retaining a native handle", async () => {
  await using directory = await tmpdir()
  const input = { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: directory.path, env: {} }
  expect(() => NativePty.spawn({ ...input, cwd: path.join(directory.path, "missing") })).toThrow("spawn failed")
  expect(() => NativePty.spawn({ ...input, rows: 0 })).toThrow("dimensions")
  const child = NativePty.spawn(input)
  try {
    const failed = once(child.stdin, "error")
    child.stdin.write(Buffer.alloc(1024 * 1024 + 1))
    expect((await failed)[0].message).toContain("bound")
    child.kill()
    child.stdout.resume()
    await child.exited
  } finally {
    child.close()
  }
})
