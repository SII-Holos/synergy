import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { sha256File } from "../../src/installation/files"

test("durable inventory hashing supports Windows flush access without changing file bytes", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-inventory-flush-"))
  try {
    const filename = path.join(directory, "module.js")
    const content = "export const value = 'durable'\n"
    await Bun.write(filename, content)
    const script = `
      import fs from "node:fs/promises"
      import { sha256File } from ${JSON.stringify(new URL("../../src/installation/files.ts", import.meta.url).href)}
      const filename = ${JSON.stringify(filename)}
      Object.defineProperty(process, "platform", { value: "win32" })
      const open = fs.open.bind(fs)
      let flushes = 0
      fs.open = async (...args) => {
        const file = await open(...args)
        if (args[0] !== filename) return file
        const sync = file.sync.bind(file)
        file.sync = async () => {
          if (args[1] === "r") throw Object.assign(new Error("Windows flush requires write access"), { code: "EPERM" })
          await sync()
          flushes++
        }
        return file
      }
      const digest = await sha256File(filename, true)
      console.log(JSON.stringify({ digest, flushes, content: await fs.readFile(filename, "utf8") }))
    `
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    expect(JSON.parse(stdout)).toEqual({
      digest: createHash("sha256").update(content).digest("hex"),
      flushes: 1,
      content,
    })
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === "win32")("durable inventory hashing preserves read-only POSIX files", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-inventory-readonly-"))
  const filename = path.join(directory, "module.js")
  try {
    const content = "export const value = 'readonly'\n"
    await Bun.write(filename, content)
    await fs.chmod(filename, 0o444)
    expect(await sha256File(filename, true)).toBe(createHash("sha256").update(content).digest("hex"))
    expect(await Bun.file(filename).text()).toBe(content)
    expect((await fs.stat(filename)).mode & 0o777).toBe(0o444)
  } finally {
    await fs.chmod(filename, 0o600).catch(() => {})
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("hashing a module inventory preserves subsequent subprocess pipes and IPC", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-inventory-io-"))
  try {
    const sizes = [0, 17, 65536, 65537, 1024 * 1024, 5 * 1024 * 1024]
    for (const [index, size] of sizes.entries()) {
      const bytes = new Uint8Array(size).fill(index)
      const file = path.join(directory, String(index))
      await Bun.write(file, bytes)
      expect(await sha256File(file, true)).toBe(createHash("sha256").update(bytes).digest("hex"))
    }
    const messages: unknown[] = []
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        'console.error("worker started"); process.on("message", message => { process.send(message); process.exit(0) })',
      ],
      {
        ipc: (message) => messages.push(message),
        serialization: "advanced",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    child.send({ ready: true })
    const timer = setTimeout(() => child.kill(), 2000)
    try {
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
      expect(code, stderr).toBe(0)
      expect(messages).toEqual([{ ready: true }])
      expect(stderr).toContain("worker started")
    } finally {
      clearTimeout(timer)
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
