import { expect, test } from "bun:test"
import path from "node:path"
import { SandboxBackend } from "../../src/sandbox/backend"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime({ env: { SYNERGY_PRIVATE_PROBE: "must-not-reach-child" } })

function wrapper(script: string) {
  return { command: process.execPath, args: ["-e", script], sandboxed: false }
}

test("async sandbox execution streams bounded output, filters ambient credentials and cleans its profile", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    const tempPath = path.join(directory.path, "profile.sb")
    await Bun.write(tempPath, "test profile")
    const output: string[] = []
    const errors: string[] = []
    let pid = 0
    const result = await SandboxBackend.executeAsync(
      {
        ...wrapper('console.log(process.env.SYNERGY_PRIVATE_PROBE ?? "no-secret");console.error("diagnostic")'),
        tempPath,
      },
      {
        fallbackPolicy: "deny",
        cwd: directory.path,
        env: { APPROVED_PROBE: "authorized" },
        after_spawn(value) {
          pid = value
        },
        onStdout(chunk) {
          output.push(chunk.toString())
        },
        onStderr(chunk) {
          errors.push(chunk.toString())
        },
      },
    )
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "no-secret\n",
      stderr: "diagnostic\n",
      timedOut: false,
      truncated: false,
    })
    expect(pid).toBeGreaterThan(0)
    expect(output.join("")).toBe(result.stdout)
    expect(errors.join("")).toBe(result.stderr)
    expect(await Bun.file(tempPath).exists()).toBe(false)
  }))

test("async sandbox execution preserves nonzero exits and bounds captured output", () =>
  runtime.run(async () => {
    const failed = await SandboxBackend.executeAsync(wrapper('console.error("failed-work");process.exit(7)'), {
      fallbackPolicy: "allow",
    })
    expect(failed).toMatchObject({ exitCode: 7, stderr: "failed-work\n", timedOut: false })
    const capped = await SandboxBackend.executeAsync(wrapper('process.stdout.write("x".repeat(1024))'), {
      fallbackPolicy: "allow",
      maxOutputBytes: 16,
    })
    expect(capped).toMatchObject({ exitCode: 0, stdout: "x".repeat(16), truncated: true })
  }))

test("async sandbox execution terminates on timeout and an already aborted signal", () =>
  runtime.run(async () => {
    const command = wrapper("setInterval(() => {}, 1000)")
    const timeout = await SandboxBackend.executeAsync(command, { fallbackPolicy: "allow", timeoutMs: 50 })
    expect(timeout.timedOut).toBe(true)
    const aborted = await SandboxBackend.executeAsync(command, { fallbackPolicy: "allow", signal: AbortSignal.abort() })
    expect(aborted.timedOut).toBe(true)
  }))

test("unavailable sandbox denies execution before spawning and explicit fallback remains observable", () =>
  runtime.run(async () => {
    const command = { ...wrapper('console.log("fallback")'), skipReason: "test host unavailable" }
    await expect(SandboxBackend.executeAsync(command, { fallbackPolicy: "deny" })).rejects.toThrow(
      "Sandbox required but unavailable",
    )
    expect(
      (await SandboxBackend.executeAsync(command, { fallbackPolicy: "warn", networkMode: "restricted" })).stdout,
    ).toBe("fallback\n")
  }))

afterRuntimeTests(() => runtime.close())
