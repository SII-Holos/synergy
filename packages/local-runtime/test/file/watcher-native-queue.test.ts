import { expect, test } from "bun:test"
import path from "node:path"

test.skipIf(process.platform !== "darwin")(
  "concurrent missing-root subscribers settle native rejections in an isolated child",
  async () => {
    const child = Bun.spawn(
      [process.execPath, path.resolve(import.meta.dir, "../fixtures/watcher-subscription-queue.ts")],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const timeout = setTimeout(() => child.kill(), 8000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(code, stderr).toBe(0)
      expect(JSON.parse(stdout)).toEqual({ rejected: 400, maximum: 1 })
    } finally {
      clearTimeout(timeout)
      if (child.exitCode === null) child.kill()
    }
  },
  10000,
)
