import { expect, test } from "bun:test"
import path from "node:path"
import { z } from "zod"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"

const Evidence = z.object({
  restart: z.boolean(),
  joined: z.literal(true),
  executions: z.array(z.string()),
  summary: z.object({ completed: z.literal(0), failed: z.literal(0) }),
})

test("released project replay waits for product-started convergence and retains its receipts across restart", async () => {
  const isolated = await createIsolatedTestEnv()
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "test",
        "--preload",
        path.join(import.meta.dirname, "fixtures/released-project-convergence-preload.ts"),
        "test/storage/released-project-upgrade.test.ts",
        "--test-name-pattern",
        "^v3\\.0\\.22 complete Runtime upgrades symlink-loop project folders and restarts with readable history$",
      ],
      { cwd: path.resolve(import.meta.dirname, "../.."), env: isolated.env, stdout: "pipe", stderr: "pipe" },
    )
    const stop = new AbortController()
    const output = { stdout: "", stderr: "" }
    let exited = false
    const exit = child.exited.then((code) => {
      exited = true
      return code
    })
    let timedOut = false
    const deadline = setTimeout(() => {
      timedOut = true
      if (!exited) child.kill("SIGKILL")
      stop.abort(new Error("Released project convergence child exceeded its lifecycle deadline"))
    }, 55_000)
    const drain = (stream: ReadableStream<Uint8Array>, target: keyof typeof output) => {
      const decoder = new TextDecoder()
      return stream.pipeTo(
        new WritableStream<Uint8Array>({
          write(chunk) {
            output[target] += decoder.decode(chunk, { stream: true })
          },
          close() {
            output[target] += decoder.decode()
          },
        }),
        { signal: stop.signal },
      )
    }
    const reads = [drain(child.stdout, "stdout"), drain(child.stderr, "stderr")]
    try {
      const [code] = await Promise.all([exit, ...reads])
      const { stdout, stderr } = output
      expect(timedOut, stdout + stderr).toBe(false)
      expect(code, stdout + stderr).toBe(0)
      const prefix = "[released project convergence] "
      const rows = (stdout + stderr)
        .split("\n")
        .filter((line) => line.startsWith(prefix))
        .map((line) => Evidence.parse(JSON.parse(line.slice(prefix.length))))
      expect(rows.map((row) => row.restart)).toEqual([false, true])
      for (const row of rows)
        expect(row.executions).toEqual([
          "convergence/20260928-independent-usage-ledger-v1",
          "convergence/20261009-usage-response-recovery-v1",
        ])
    } catch (error) {
      if (timedOut) throw new Error(output.stdout + output.stderr, { cause: error })
      throw error
    } finally {
      clearTimeout(deadline)
      stop.abort()
      if (!exited) {
        child.kill("SIGKILL")
      }
      await Promise.allSettled([exit, ...reads])
    }
  } finally {
    await isolated.dispose()
  }
}, 60_000)
