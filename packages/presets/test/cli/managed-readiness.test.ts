import { expect, test } from "bun:test"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { RUNTIME_STARTUP_PREFIX, RuntimeStartupProgress } from "@ericsanchezok/synergy-util/runtime-startup"

test("managed CLI waits for the whole factory on fresh startup and restart even when HTTP is healthy", async () => {
  await using tmp = await tmpdir()
  for (const state of ["fresh", "restart"]) {
    const child = Bun.spawn(
      [
        process.execPath,
        "--conditions=browser",
        "test/cli/fixture/managed-readiness.ts",
        "server",
        "--port",
        "0",
        "--hostname",
        "127.0.0.1",
        "--non-interactive",
        "--no-banner",
      ],
      {
        cwd: import.meta.dir + "/../..",
        env: {
          ...process.env,
          SYNERGY_HOME: `${tmp.path}/home`,
          SYNERGY_CWD: tmp.path,
          SYNERGY_DESKTOP_STARTUP_PROGRESS: "1",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const stderr = new Response(child.stderr).text()
    const timeout = setTimeout(() => child.kill(), 20_000)
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let output = ""
    const readUntil = async (predicate: (output: string) => boolean) => {
      while (!predicate(output)) {
        const { value, done } = await reader.read()
        if (done) throw new Error(`CLI closed before readiness: ${await stderr}`)
        output += decoder.decode(value, { stream: true })
      }
    }
    const events = () =>
      output
        .split("\n")
        .slice(0, -1)
        .filter((line) => line.startsWith(RUNTIME_STARTUP_PREFIX))
        .map((line) => RuntimeStartupProgress.parse(JSON.parse(line.slice(RUNTIME_STARTUP_PREFIX.length))))
    try {
      await readUntil((text) => /\{"fixture":"runtime-open","port":\d+\}\n/.test(text))
      const opened = output.split("\n").find((line) => line.startsWith('{"fixture":"runtime-open"'))!
      const { port } = JSON.parse(opened) as { port: number }
      expect((await fetch(`http://127.0.0.1:${port}/global/health`)).ok, state).toBe(true)
      expect(
        events().some((event) => event.phase === "runtime" && event.state === "ready"),
        state,
      ).toBe(false)
      child.stdin.end()
      await readUntil(() => events().some((event) => event.phase === "runtime" && event.state === "ready"))
      expect(output.indexOf('"state":"ready"')).toBeGreaterThan(output.indexOf("fixture-factory-returning"))
      expect(events().filter((event) => event.phase === "runtime" && event.state === "ready")).toHaveLength(1)
    } finally {
      clearTimeout(timeout)
      child.kill()
      await child.exited
      reader.releaseLock()
    }
  }
}, 60_000)
