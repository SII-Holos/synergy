import { describe, expect, test } from "bun:test"
import { once, readPipedStdin } from "../../src/cli/stdin"

describe("once", () => {
  test("calls function only once", () => {
    let count = 0
    const fn = once(() => {
      count++
    })
    fn()
    fn()
    fn()
    expect(count).toBe(1)
  })

  test("passes arguments on first call", () => {
    const results: number[][] = []
    const fn = once((...args: number[]) => {
      results.push(args)
    })
    fn(1, 2)
    fn(3, 4)
    expect(results).toEqual([[1, 2]])
  })
})

describe("readPipedStdin", () => {
  test("reads piped input", async () => {
    const proc = Bun.spawn({
      cmd: [
        "bun",
        "-e",
        `const { readPipedStdin } = await import("./src/cli/stdin"); process.stdout.write(await readPipedStdin())`,
      ],
      cwd: import.meta.dir + "/../..",
      stdin: "pipe",
      stdout: "pipe",
    })
    proc.stdin.write("hello from pipe")
    proc.stdin.end()

    const out = await new Response(proc.stdout).text()
    expect(out).toBe("hello from pipe")
    expect(await proc.exited).toBe(0)
  })

  test("returns empty when no data arrives within timeout", async () => {
    const proc = Bun.spawn({
      cmd: [
        "bun",
        "-e",
        `const { readPipedStdin } = await import("./src/cli/stdin"); const start = Date.now(); const text = await readPipedStdin(); process.stdout.write(JSON.stringify({ text, elapsed: Date.now() - start }))`,
      ],
      cwd: import.meta.dir + "/../..",
      stdin: "pipe",
      stdout: "pipe",
    })
    // Close stdin immediately — no data, but EOF is sent so the process exits.
    proc.stdin.end()

    const out = await new Response(proc.stdout).text()
    const result = JSON.parse(out)
    expect(result.text).toBe("")
    // /dev/null or immediate EOF should resolve near-instantly
    expect(result.elapsed).toBeLessThan(500)
    expect(await proc.exited).toBe(0)
  })

  test("reads from /dev/null", async () => {
    const proc = Bun.spawn({
      cmd: [
        "bun",
        "-e",
        `const { readPipedStdin } = await import("./src/cli/stdin"); process.stdout.write(await readPipedStdin())`,
      ],
      cwd: import.meta.dir + "/../..",
      stdin: Bun.file("/dev/null"),
      stdout: "pipe",
    })

    const out = await new Response(proc.stdout).text()
    expect(out).toBe("")
    expect(await proc.exited).toBe(0)
  })
})
