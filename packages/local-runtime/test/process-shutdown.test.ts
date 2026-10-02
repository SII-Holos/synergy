import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { expect, test } from "bun:test"
import { ProcessRegistry } from "@ericsanchezok/synergy-harness/process/registry"
import { ProcessInspection } from "@ericsanchezok/synergy-harness/process/inspection"
import { ChildProcessClose } from "@ericsanchezok/synergy-harness/process/child-process-close"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { LocalBashBackend } from "../src/tools/bash/local"
import { testRuntime } from "./support/runtime"

test("closing a Runtime drains a background child even after its history entry is removed", async () => {
  const controller = new AbortController()
  const expired = Promise.withResolvers<never>()
  void expired.promise.catch(() => {})
  let phase = "opening Runtime"
  let runtime: Awaited<ReturnType<typeof testRuntime>> | undefined
  let execution: ReturnType<typeof LocalBashBackend.execute> | undefined
  const timer = setTimeout(() => {
    const error = new Error(`Runtime shutdown fixture stalled while ${phase}`)
    console.error(error.message)
    if (runtime && phase !== "closing Runtime")
      console.error(
        "Runtime shutdown fixture processes",
        runtime.run(() =>
          ProcessRegistry.listRunning().map((process) => ({
            prepared: !!process.child,
            activated: !!process.child?.pid,
            backgrounded: process.backgrounded,
            exited: process.exited,
            stdioState: process.stdioState,
          })),
        ),
      )
    controller.abort(error)
    expired.reject(error)
  }, 20_000)
  try {
    runtime = await testRuntime({
      env: { SHELL: process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh" },
    })
    phase = "creating directory"
    await using directory = await tmpdir()
    const { child, pid, closed } = await runtime.run(async () => {
      phase = "resolving Scope"
      const scope = await directory.scope()
      return ScopeContext.provide({
        scope,
        fn: async () => {
          const ready = Promise.withResolvers<number>()
          const script = Buffer.from("setInterval(() => {}, 1000); console.log('ready:' + process.pid)").toString(
            "base64",
          )
          const command = `"${process.execPath}" -e "eval(Buffer.from('${script}', 'base64').toString())"`
          phase = "starting shell"
          controller.signal.throwIfAborted()
          execution = LocalBashBackend.execute(
            { command, yieldSeconds: 0.01 },
            {
              sessionID: "process-owner",
              messageID: "message",
              agent: PrimaryAgentIdentity.names.general,
              abort: controller.signal,
              metadata({ metadata }) {
                const match = /^ready:(\d+)\r?\n/.exec(metadata?.output ?? "")
                if (match) ready.resolve(Number(match[1]))
              },
              async ask() {},
              extra: { shellBypassSandbox: true },
            },
          )
          const result = await Promise.race([execution, expired.promise])
          expect(result.metadata.background).toBe(true)
          const owned = ProcessRegistry.get(result.metadata.processId!)!
          const child = owned.child!
          const closed = ChildProcessClose.wait(child)
          phase = "waiting for child readiness"
          const pid = await Promise.race([
            ready.promise,
            expired.promise,
            closed.then((result) => {
              throw new Error(`Child exited before readiness: ${JSON.stringify(result)}; output: ${owned.output}`)
            }),
          ])
          expect(ProcessInspection.alive(pid)).toBe(true)
          expect(child.exitCode).toBeNull()
          expect(child.signalCode).toBeNull()
          ProcessRegistry.remove(owned.id)
          expect(ProcessRegistry.get(owned.id)).toBeUndefined()
          return { child, pid, closed }
        },
      })
    })
    phase = "closing Runtime"
    await runtime.close()
    await closed
    expect(ProcessInspection.alive(pid)).toBe(false)
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    expect(child.stdout?.destroyed).toBe(true)
    expect(child.stderr?.destroyed).toBe(true)
  } catch (error) {
    throw new Error(`Runtime shutdown fixture failed while ${phase}`, { cause: error })
  } finally {
    controller.abort(new Error("Runtime shutdown fixture closed"))
    try {
      phase = "draining Bash execution"
      await execution?.catch(() => {})
      phase = "closing Runtime"
      await runtime?.close()
    } finally {
      clearTimeout(timer)
    }
  }
}, 30_000)
