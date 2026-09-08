import { describe, expect, test } from "bun:test"

async function classifyInChild(command: string, timeoutMs = 500) {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "-e",
      `
        import { ShellSafety } from "./src/enforcement/shell-safety.ts"
        process.stdout.write(ShellSafety.classifyBashRisk(${JSON.stringify(command)}))
      `,
    ],
    cwd: import.meta.dir + "/../..",
    stdout: "pipe",
    stderr: "pipe",
  })

  let timedOut = false
  const completed = await Promise.race([child.exited.then(() => true), Bun.sleep(timeoutMs).then(() => false)])
  if (!completed) {
    timedOut = true
    child.kill()
    await child.exited
  }

  return {
    timedOut,
    exitCode: child.exitCode,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  }
}

describe("ShellSafety process liveness", () => {
  test("classifies the |& compound operator without recursive re-entry", async () => {
    const result = await classifyInChild("ls |& cat")

    expect(result.timedOut).toBe(false)
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toBe("shell_read")
  })
})
