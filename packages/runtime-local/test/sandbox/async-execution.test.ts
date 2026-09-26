import { expect, test } from "bun:test"
import path from "node:path"
import { SandboxBackend } from "../../src/sandbox/backend"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
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

test(
  "sandbox execution retains its actual write footprint until detached descendants exit",
  () =>
    runtime.run(async () => {
      await using directory = await tmpdir()
      await ScopeContext.provide({
        scope: await directory.scope(),
        async fn() {
          const marker = path.join(directory.path, "started")
          const stop = path.join(directory.path, "stop")
          const program = `await Bun.write(${JSON.stringify(marker)}, String(process.pid)); while (!(await Bun.file(${JSON.stringify(stop)}).exists())) await Bun.sleep(20)`
          const root = `import {spawn} from 'node:child_process'; const child=spawn(process.execPath,['-e',${JSON.stringify(program)}],{env:{},stdio:'ignore',detached:true}); child.unref()`
          const running = SandboxBackend.executeAsync(wrapper(root), {
            fallbackPolicy: "allow",
            cwd: directory.path,
            timeoutMs: 10000,
          })
          void running.catch(() => {})
          try {
            const deadline = Date.now() + 5000
            while (!(await Bun.file(marker).exists())) {
              if (Date.now() > deadline) throw new Error("Sandbox descendant did not start")
              await Bun.sleep(10)
            }
            await expect(
              WorkspaceAccess.write([directory.path], async () => {}, AbortSignal.timeout(100)),
            ).rejects.toMatchObject({ name: "TimeoutError" })
            await Bun.write(stop, "stop")
            expect(await running).toMatchObject({ exitCode: 0, timedOut: false })
            await WorkspaceAccess.write([directory.path], async () => {})
          } finally {
            await Bun.write(stop, "stop")
            await running
          }
        },
      })
    }),
  15000,
)

test(
  "sandbox cancellation while queued starts no process and removes the prepared profile",
  () =>
    runtime.run(async () => {
      await using directory = await tmpdir()
      const marker = path.join(directory.path, "must-not-start")
      const tempPath = path.join(directory.path, "profile")
      await Bun.write(tempPath, "prepared")
      const lease = await WorkspaceAccess.process(null)
      const controller = new AbortController()
      const running = SandboxBackend.executeAsync(
        { ...wrapper(`await Bun.write(${JSON.stringify(marker)}, 'started')`), tempPath },
        { fallbackPolicy: "allow", cwd: directory.path, signal: controller.signal },
      )
      try {
        await Bun.sleep(200)
        expect(await Bun.file(marker).exists()).toBe(false)
        controller.abort()
        expect(await running).toMatchObject({ timedOut: true, exitCode: -1 })
        expect(await Bun.file(tempPath).exists()).toBe(false)
      } finally {
        controller.abort()
        await lease.release()
        await running
      }
    }),
  15000,
)

test(
  "a bounded sandbox capture keeps draining multi-megabyte stdout and stderr",
  () =>
    runtime.run(async () => {
      let observed = 0
      const result = await SandboxBackend.executeAsync(
        wrapper(
          `await Bun.write(Bun.stdout, Buffer.alloc(8 * 1024 * 1024, 120)); await Bun.write(Bun.stderr, Buffer.alloc(1024 * 1024, 121))`,
        ),
        {
          fallbackPolicy: "allow",
          timeoutMs: 4000,
          maxOutputBytes: 17000,
          onStdout(chunk) {
            observed += chunk.length
          },
          onStderr(chunk) {
            observed += chunk.length
          },
        },
      )
      expect(result).toMatchObject({ exitCode: 0, timedOut: false, truncated: true })
      expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBe(17000)
      expect(observed).toBe(9 * 1024 * 1024)
    }),
  10000,
)
