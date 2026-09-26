import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { sha256File } from "../../src/installation/files"

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
