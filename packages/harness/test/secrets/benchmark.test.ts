import { expect, test } from "bun:test"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

test("pipeline benchmark owns an isolated home and reports both registration paths", () =>
  runtime.run(async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("../../script/secrets-benchmark.ts", import.meta.url).pathname,
        "--quick",
        "--samples",
        "2",
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, stderr).toBe(0)
    const result = JSON.parse(stdout)
    expect(result.rows.map((row: { mode: string }) => row.mode)).toEqual(["first-registration", "already-registered"])
    expect(stdout).not.toContain("ghp_")
  }))

afterRuntimeTests(() => runtime.close())
