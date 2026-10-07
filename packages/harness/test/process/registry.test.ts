import { describe, expect, test, beforeEach } from "bun:test"
import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdtemp, chmod, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { ProcessInspection } from "../../src/process/inspection"
import { ProcessRegistry } from "../../src/process/registry"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

beforeEach(() =>
  runtime.run(() => {
    ProcessRegistry.reset()
  }),
)

describe("ProcessRegistry.appendOutput", () => {
  test("accumulates chunks into output", () =>
    runtime.run(() => {
      const proc = ProcessRegistry.create({ command: "test" })
      ProcessRegistry.appendOutput(proc, "hello ")
      ProcessRegistry.appendOutput(proc, "world")
      expect(proc.output).toBe("hello world")
      expect(proc.truncated).toBe(false)
    }))

  test("truncates to last MAX_OUTPUT_CHARS when exceeded", () =>
    runtime.run(() => {
      const proc = ProcessRegistry.create({ command: "test" })
      // MAX_OUTPUT_CHARS is 200_000
      const chunk = "x".repeat(150_000)
      ProcessRegistry.appendOutput(proc, chunk)
      expect(proc.output.length).toBe(150_000)
      expect(proc.truncated).toBe(false)

      // Append another chunk that pushes over the limit
      ProcessRegistry.appendOutput(proc, chunk)
      expect(proc.output.length).toBeLessThanOrEqual(200_000)
      expect(proc.truncated).toBe(true)
      // The kept output should be the tail (most recent data)
      expect(proc.output.endsWith("x")).toBe(true)
    }))

  test("tail stays within TAIL_CHARS limit", () =>
    runtime.run(() => {
      const proc = ProcessRegistry.create({ command: "test" })
      ProcessRegistry.appendOutput(proc, "a".repeat(5000))
      expect(proc.tail.length).toBeLessThanOrEqual(2000)
      expect(proc.tail).toBe("a".repeat(2000))
    }))

  test("handles many small chunks without data loss before cap", () =>
    runtime.run(() => {
      const proc = ProcessRegistry.create({ command: "test" })
      const chunkCount = 1000
      for (let i = 0; i < chunkCount; i++) {
        ProcessRegistry.appendOutput(proc, `line ${i}\n`)
      }
      // All lines should be present (total is well under 200K)
      const lines = proc.output.trim().split("\n")
      expect(lines.length).toBe(chunkCount)
      expect(lines[0]).toBe("line 0")
      expect(lines[chunkCount - 1]).toBe(`line ${chunkCount - 1}`)
    }))

  test("sliding window preserves most recent data", () =>
    runtime.run(() => {
      const proc = ProcessRegistry.create({ command: "test" })
      // Fill to near capacity with "old" data
      ProcessRegistry.appendOutput(proc, "OLD_".repeat(50_000)) // 200K chars
      // Now append "new" data that pushes old data out
      const newData = "NEW_DATA_MARKER"
      ProcessRegistry.appendOutput(proc, newData)
      expect(proc.output).toContain(newData)
      expect(proc.truncated).toBe(true)
    }))

  test("coalesces micro-chunks into a bounded number of output segments", () =>
    runtime.run(() => {
      const proc = ProcessRegistry.create({ command: "test" })
      for (let index = 0; index < 50_000; index++) ProcessRegistry.appendOutput(proc, "x")

      expect(proc.output).toBe("x".repeat(50_000))
      expect(ProcessRegistry.outputBufferStats(proc).segments).toBeLessThan(32)
    }))

  test("releases fully consumed output segments", () =>
    runtime.run(() => {
      const proc = ProcessRegistry.create({ command: "test" })
      proc.maxOutputChars = 0

      ProcessRegistry.appendOutput(proc, "x".repeat(4096))

      expect(ProcessRegistry.outputBufferStats(proc).allocatedSegments).toBe(0)
    }))

  test("maintains the exact retained window and tail after micro-chunks exceed capacity", () =>
    runtime.run(() => {
      const proc = ProcessRegistry.create({ command: "test" })
      const chunks: string[] = []
      for (let index = 0; index < 2_500; index++) {
        const chunk = `line_${String(index).padStart(6, "0")}_${"x".repeat(84)}\n`
        chunks.push(chunk)
        ProcessRegistry.appendOutput(proc, chunk)
      }
      const expected = chunks.join("").slice(-200_000)

      expect(proc.output).toBe(expected)
      expect(proc.tail).toBe(expected.slice(-2_000))
      expect(proc.truncated).toBe(true)
    }))
})

describe("ProcessRegistry lifecycle", () => {
  test("create and remove", () =>
    runtime.run(() => {
      const proc = ProcessRegistry.create({ command: "echo hi" })
      expect(ProcessRegistry.get(proc.id)).toBeDefined()
      ProcessRegistry.remove(proc.id)
      expect(ProcessRegistry.get(proc.id)).toBeUndefined()
    }))

  test("markExited moves backgrounded process to finished", () =>
    runtime.run(() => {
      const proc = ProcessRegistry.create({ command: "echo hi" })
      ProcessRegistry.markBackgrounded(proc)
      ProcessRegistry.markExited(proc, 0, null)
      expect(ProcessRegistry.get(proc.id)).toBeUndefined()
      const finished = ProcessRegistry.getFinished(proc.id)
      expect(finished).toBeDefined()
      expect(finished!.status).toBe("completed")
    }))

  test("markExited always persists into the finished registry", () =>
    runtime.run(() => {
      const proc = ProcessRegistry.create({ command: "echo hi" })
      // Don't call markBackgrounded — a fast-exiting process may finish before
      // the auto-background timer fires. It should still be findable via
      // getFinished so callers don't race the exit.
      ProcessRegistry.markExited(proc, 0, null)
      expect(ProcessRegistry.get(proc.id)).toBeUndefined()
      expect(ProcessRegistry.getFinished(proc.id)!.status).toBe("completed")
    }))

  test("failed exit code produces failed status", () =>
    runtime.run(() => {
      const proc = ProcessRegistry.create({ command: "false" })
      ProcessRegistry.markBackgrounded(proc)
      ProcessRegistry.markExited(proc, 1, null)
      const finished = ProcessRegistry.getFinished(proc.id)
      expect(finished!.status).toBe("failed")
    }))

  test("SIGKILL produces killed status", () =>
    runtime.run(() => {
      const proc = ProcessRegistry.create({ command: "sleep" })
      ProcessRegistry.markBackgrounded(proc)
      ProcessRegistry.markExited(proc, null, "SIGKILL")
      const finished = ProcessRegistry.getFinished(proc.id)
      expect(finished!.status).toBe("killed")
    }))
  test("uses an owned process-tree terminator before the child fallback", () =>
    runtime.run(async () => {
      const proc = ProcessRegistry.create({ command: "owned child" })
      let terminated = 0
      ProcessRegistry.setTerminator(proc, () => {
        terminated++
      })

      await ProcessRegistry.terminate(proc)

      expect(terminated).toBe(1)
    }))

  test("forwards drain-timeout cleanup after the direct parent exits", () =>
    runtime.run(async () => {
      const proc = ProcessRegistry.create({ command: "exited parent" })
      proc.exited = true
      let terminated = 0
      ProcessRegistry.setTerminator(proc, () => {
        terminated++
      })

      await ProcessRegistry.terminate(proc, { allowExitedParent: true })

      expect(terminated).toBe(1)
    }))

  test("resource snapshot reports inspected child process RSS", () =>
    runtime.run(async () => {
      const restore = ProcessRegistry.setProcessInspector(() => ({ alive: true, rssBytes: 4096 }))
      const proc = ProcessRegistry.create({ command: "node server.js" })
      proc.pid = 1234
      ProcessRegistry.markBackgrounded(proc)

      const snapshot = await ProcessRegistry.resourceSnapshot({ now: proc.startedAt + 1000 })

      restore()
      expect(snapshot).toHaveLength(1)
      expect(snapshot[0]).toMatchObject({
        id: proc.id,
        pid: 1234,
        command: "node server.js",
        backgrounded: true,
        ageMs: 1000,
        alive: true,
        rssBytes: 4096,
        stdioState: "open",
      })
    }))

  test("reports exit observation, stdio drain grace, and timeout state", () =>
    runtime.run(async () => {
      const restore = ProcessRegistry.setProcessInspector(() => ({ alive: true, rssBytes: 4096 }))
      const proc = ProcessRegistry.create({ command: "sleep 10" })
      proc.pid = 1234

      ProcessRegistry.markExitObserved(proc, { drainGraceMs: 1_000, timedOut: true })
      const snapshot = await ProcessRegistry.resourceSnapshot()

      restore()
      expect(snapshot[0]).toMatchObject({
        stdioState: "draining",
        drainGraceMs: 1_000,
        timedOut: true,
      })
      expect(snapshot[0].exitObservedAt).toBeNumber()
    }))

  test("settleStaleProcesses moves missing child processes to finished", () =>
    runtime.run(async () => {
      const restore = ProcessRegistry.setProcessInspector(() => ({ alive: false }))
      const proc = ProcessRegistry.create({ command: "missing child" })
      proc.pid = 999999
      ProcessRegistry.markBackgrounded(proc)

      await ProcessRegistry.settleStaleProcesses()

      restore()
      expect(ProcessRegistry.get(proc.id)).toBeUndefined()
      expect(ProcessRegistry.getFinished(proc.id)?.status).toBe("failed")
    }))
  test("preserves unknown owned child liveness and its terminator instead of probing the PID", () =>
    runtime.run(async () => {
      const restore = ProcessRegistry.setProcessInspector(() => ({}))
      try {
        for (const pid of [process.pid, 2_147_483_647]) {
          const child = Object.assign(new EventEmitter(), {
            pid,
            stdin: null,
            stdout: null,
            stderr: null,
            exitCode: null,
            signalCode: null,
            alive: () => undefined,
            kill: () => false,
          })
          const proc = ProcessRegistry.create({ command: "unknown owned child", child })
          let terminated = 0
          ProcessRegistry.setTerminator(proc, () => {
            terminated++
          })
          try {
            const snapshot = await ProcessRegistry.resourceSnapshot({ settleStale: true })
            expect(snapshot.find((entry) => entry.id === proc.id)?.alive).toBeUndefined()
            expect(ProcessRegistry.get(proc.id)).toBe(proc)
            expect(ProcessRegistry.getFinished(proc.id)).toBeUndefined()
            await ProcessRegistry.terminate(proc)
            expect(terminated).toBe(1)
          } finally {
            ProcessRegistry.remove(proc.id)
          }
        }
      } finally {
        restore()
      }
    }))

  test("only the latest sampling generation updates current, baseline and peak RSS", () =>
    runtime.run(async () => {
      const proc = ProcessRegistry.create({ command: "delayed sample" })
      proc.pid = 1234
      const started = Promise.withResolvers<void>()
      const pending = Promise.withResolvers<ProcessRegistry.ProcessInspection>()
      let calls = 0
      const restore = ProcessRegistry.setProcessInspector(() => {
        if (++calls > 1) return { alive: true, rssBytes: 4096 }
        started.resolve()
        return pending.promise
      })
      try {
        const older = ProcessRegistry.resourceSnapshot()
        await started.promise
        expect((await ProcessRegistry.resourceStats()).currentBytes).toBe(4096)
        pending.resolve({ alive: true, rssBytes: 8192 })
        expect((await older)[0].rssBytes).toBeUndefined()
        expect(proc.currentRssBytes).toBe(4096)
        expect(proc.baselineRssBytes).toBe(4096)
        expect(proc.peakRssBytes).toBe(4096)
      } finally {
        pending.resolve({})
        restore()
      }
    }))

  test("clears failed measurements without recording zero or retaining stale RSS", () =>
    runtime.run(async () => {
      const proc = ProcessRegistry.create({ command: "missing measurement" })
      proc.pid = 1234
      let measured = true
      const restore = ProcessRegistry.setProcessInspector(() =>
        measured ? { alive: true, rssBytes: 4096 } : { alive: true },
      )
      try {
        expect((await ProcessRegistry.resourceStats()).measuredProcessCount).toBe(1)
        measured = false
        expect(await ProcessRegistry.resourceStats()).toMatchObject({
          processCount: 1,
          measuredProcessCount: 0,
          currentBytes: 0,
        })
        expect(proc.currentRssBytes).toBeUndefined()
        expect(proc.baselineRssBytes).toBe(4096)
        expect(proc.peakRssBytes).toBe(4096)
      } finally {
        restore()
      }
    }))

  test("rejects an in-flight sample after exit observation, replacement or removal", () =>
    runtime.run(async () => {
      for (const invalidate of ["exit", "pid", "remove"] as const) {
        const proc = ProcessRegistry.create({ command: invalidate })
        proc.pid = 1234
        const started = Promise.withResolvers<void>()
        const pending = Promise.withResolvers<ProcessRegistry.ProcessInspection>()
        const restore = ProcessRegistry.setProcessInspector(() => {
          started.resolve()
          return pending.promise
        })
        try {
          const query = ProcessRegistry.resourceSnapshot()
          await started.promise
          if (invalidate === "exit") ProcessRegistry.markExitObserved(proc, { drainGraceMs: 1000, timedOut: false })
          if (invalidate === "pid") proc.pid = 5678
          if (invalidate === "remove") ProcessRegistry.remove(proc.id)
          pending.resolve({ alive: true, rssBytes: 4096 })
          const snapshot = await query
          expect(snapshot.find((entry) => entry.id === proc.id)?.rssBytes).toBeUndefined()
          expect(proc.currentRssBytes).toBeUndefined()
          expect(proc.peakRssBytes).toBeUndefined()
        } finally {
          pending.resolve({})
          restore()
          ProcessRegistry.remove(proc.id)
        }
      }
    }))

  test("bounds per-PID fallback concurrency and signals cancellation at the deadline", () =>
    runtime.run(async () => {
      for (let index = 0; index < 12; index++) {
        const proc = ProcessRegistry.create({ command: "slow inspection" })
        proc.pid = 1000 + index
      }
      let active = 0
      let maximum = 0
      let calls = 0
      const restore = ProcessRegistry.setProcessInspector(
        (_pid, _proc, signal) =>
          new Promise((resolve) => {
            calls++
            maximum = Math.max(maximum, ++active)
            signal.addEventListener(
              "abort",
              () => {
                active--
                resolve({})
              },
              { once: true },
            )
          }),
      )
      try {
        const before = performance.now()
        const snapshot = await ProcessRegistry.resourceSnapshot()
        expect(maximum).toBe(4)
        expect(calls).toBe(4)
        expect(active).toBe(0)
        expect(snapshot).toHaveLength(12)
        expect(snapshot.every((entry) => entry.rssBytes === undefined)).toBe(true)
        expect(performance.now() - before).toBeLessThan(2000)
      } finally {
        restore()
      }
    }))

  test("does not settle a process from a superseded inspection", () =>
    runtime.run(async () => {
      const proc = ProcessRegistry.create({ command: "superseded liveness" })
      proc.pid = 1234
      const started = Promise.withResolvers<void>()
      const pending = Promise.withResolvers<ProcessRegistry.ProcessInspection>()
      let calls = 0
      const restore = ProcessRegistry.setProcessInspector(() => {
        if (++calls > 1) return { alive: true, rssBytes: 4096 }
        started.resolve()
        return pending.promise
      })
      try {
        const older = ProcessRegistry.resourceSnapshot({ settleStale: true })
        await started.promise
        await ProcessRegistry.resourceStats()
        pending.resolve({ alive: false })
        await older
        expect(ProcessRegistry.get(proc.id)).toBe(proc)
        expect(ProcessRegistry.getFinished(proc.id)).toBeUndefined()
      } finally {
        pending.resolve({})
        restore()
      }
    }))

  test("keeps unresolved fallback inspections within the limit across overlapping queries", () =>
    runtime.run(async () => {
      for (let index = 0; index < 8; index++) {
        const proc = ProcessRegistry.create({ command: "ignores cancellation" })
        proc.pid = 1000 + index
      }
      const pending = Promise.withResolvers<ProcessRegistry.ProcessInspection>()
      const started = Promise.withResolvers<void>()
      let calls = 0
      const restore = ProcessRegistry.setProcessInspector(() => {
        if (++calls === 4) started.resolve()
        return pending.promise
      })
      const controller = new AbortController()
      try {
        const older = ProcessRegistry.resourceSnapshot({ signal: controller.signal })
        await started.promise
        controller.abort()
        await older
        await ProcessRegistry.resourceSnapshot()
        expect(calls).toBe(4)
      } finally {
        pending.resolve({})
        await pending.promise
        restore()
      }
    }))

  test.skipIf(process.platform !== "darwin")(
    "default OS deadline retains completed batches while caller abort discards them and both drain",
    () =>
      runtime.run(async () => {
        const children = await Promise.all(
          [0, 1].map(async () => {
            const child = spawn(process.execPath, ["-e", 'console.log("ready"); setInterval(() => {}, 1000)'], {
              stdio: ["ignore", "pipe", "ignore"],
            })
            await new Promise<void>((resolve, reject) => {
              child.stdout.once("data", () => resolve())
              child.once("error", reject)
            })
            return child
          }),
        )
        const fastProcess = ProcessRegistry.create({ command: "fast OS sample", child: children[0] })
        const unknownProcesses = Array.from({ length: 127 }, (_, index) =>
          ProcessRegistry.create({
            command: "unknown OS sample",
            child: Object.assign(new EventEmitter(), {
              pid: 2_147_483_647 - index,
              stdin: null,
              stdout: null,
              stderr: null,
              exitCode: null,
              signalCode: null,
              alive: () => undefined,
              kill: () => false,
            }),
          }),
        )
        const slowProcess = ProcessRegistry.create({ command: "slow OS sample", child: children[1] })
        const directory = await mkdtemp(path.join(tmpdir(), "synergy-registry-partial-"))
        const previousPath = process.env.PATH
        const socketPath = path.join(directory, "ready.sock")
        const fixturePath = path.join(directory, "partial.pl")
        let ready: (command: { pid: number; slow: boolean }) => void = () => {}
        const server = createServer((socket) => {
          let payload = ""
          socket.on("data", (chunk) => {
            payload += chunk.toString()
          })
          socket.on("end", () => {
            const [pid, slow] = payload.trim().split("\n")
            ready({ pid: Number(pid), slow: slow === "1" })
          })
        })
        await new Promise<void>((resolve) => server.listen(socketPath, resolve))
        await Bun.write(
          fixturePath,
          `use Socket; my $slow = $ARGV[-1] eq "${children[1].pid}"; socket(S, PF_UNIX, SOCK_STREAM, 0) or die $!; connect(S, sockaddr_un(${JSON.stringify(socketPath)})) or die $!; print S join("\\n", $$, $slow ? 1 : 0), "\\n"; close(S); if ($slow) { sleep 10; } else { print "${children[0].pid} 8 Wed Oct  7 08:30:00 2026\\n"; }`,
        )
        const commandPath = path.join(directory, "ps")
        await Bun.write(commandPath, `#!/bin/sh\nexec /usr/bin/perl ${JSON.stringify(fixturePath)} "$@"\n`)
        await chmod(commandPath, 0o755)
        process.env.PATH = directory
        const outcomes: Array<{
          snapshot: ProcessRegistry.ResourceSnapshot[]
          currentRssBytes: number | undefined
          baselineRssBytes: number | undefined
          peakRssBytes: number | undefined
        }> = []
        try {
          for (const cancellation of ["deadline", "caller abort"]) {
            const controller = new AbortController()
            const started = Promise.withResolvers<void>()
            const commands: Array<{ pid: number; slow: boolean }> = []
            ready = (command) => {
              commands.push(command)
              if (commands.length === 2) started.resolve()
            }
            const before = performance.now()
            const query = ProcessRegistry.resourceSnapshot({ signal: controller.signal, settleStale: true })
            try {
              await Promise.race([
                started.promise,
                query.then(() => {
                  throw new Error(`query ended before both batches launched: ${JSON.stringify(commands)}`)
                }),
              ])
              const fastCommand = commands.find((command) => !command.slow)!
              while (ProcessInspection.alive(fastCommand.pid)) {
                if (performance.now() - before > 500) throw new Error("completed batch failed to exit before deadline")
                await Bun.sleep(5)
              }
              if (cancellation === "caller abort") controller.abort()
              const snapshot = await query
              outcomes.push({
                snapshot,
                currentRssBytes: fastProcess.currentRssBytes,
                baselineRssBytes: fastProcess.baselineRssBytes,
                peakRssBytes: fastProcess.peakRssBytes,
              })
              expect(performance.now() - before).toBeLessThan(2000)
              for (const command of commands) expect(ProcessInspection.alive(command.pid)).toBe(false)
              expect(
                [fastProcess, ...unknownProcesses, slowProcess].every((proc) => ProcessRegistry.get(proc.id) === proc),
              ).toBe(true)
            } finally {
              controller.abort()
              await query
            }
          }
          expect(outcomes[1].snapshot).toEqual([])
          expect(outcomes[0].snapshot).toHaveLength(129)
          expect(outcomes[0].snapshot.find((entry) => entry.id === fastProcess.id)?.rssBytes).toBe(8192)
          expect(outcomes[0].snapshot.find((entry) => entry.id === slowProcess.id)?.rssBytes).toBeUndefined()
          expect(outcomes[0]).toMatchObject({ currentRssBytes: 8192, baselineRssBytes: 8192, peakRssBytes: 8192 })
          expect(outcomes[1]).toMatchObject({ currentRssBytes: 8192, baselineRssBytes: 8192, peakRssBytes: 8192 })
        } finally {
          if (previousPath === undefined) delete process.env.PATH
          else process.env.PATH = previousPath
          await new Promise<void>((resolve) => server.close(() => resolve()))
          for (const proc of [fastProcess, ...unknownProcesses, slowProcess]) ProcessRegistry.remove(proc.id)
          await Promise.all(
            children.map(async (child) => {
              if (child.exitCode !== null || child.signalCode !== null) return
              const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
              child.kill("SIGKILL")
              await closed
            }),
          )
          await rm(directory, { recursive: true, force: true })
        }
      }),
  )

  test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "samples a real owned child through resourceStats and ignores its exited PID",
    () =>
      runtime.run(async () => {
        const child = spawn(process.execPath, ["-e", 'console.log("ready"); setInterval(() => {}, 1000)'], {
          stdio: ["ignore", "pipe", "ignore"],
        })
        await new Promise<void>((resolve, reject) => {
          child.stdout.once("data", () => resolve())
          child.once("error", reject)
        })
        const proc = ProcessRegistry.create({ command: "owned fixture", child })
        try {
          expect(await ProcessRegistry.resourceStats()).toMatchObject({ processCount: 1, measuredProcessCount: 1 })
          expect(proc.currentRssBytes).toBeGreaterThan(0)
          const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
          child.kill("SIGKILL")
          await closed
          expect((await ProcessRegistry.resourceSnapshot())[0]).toMatchObject({ id: proc.id, alive: false })
          expect(proc.currentRssBytes).toBeUndefined()
          await ProcessRegistry.settleStaleProcesses()
          expect(ProcessRegistry.get(proc.id)).toBeUndefined()
        } finally {
          if (child.exitCode === null && child.signalCode === null) {
            const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
            child.kill("SIGKILL")
            await closed
          }
        }
      }),
  )
})

afterRuntimeTests(() => runtime.close())
