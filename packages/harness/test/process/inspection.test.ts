import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtemp, chmod, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { ProcessInspection } from "../../src/process/inspection"
import { parseRssOutput, rssCommand } from "../../src/process/inspection-command"

const supported = process.platform === "linux" || process.platform === "darwin"

async function startChild() {
  const child = spawn(process.execPath, ["-e", 'console.log("ready"); setInterval(() => {}, 1000)'], {
    stdio: ["ignore", "pipe", "ignore"],
  })
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve())
    child.once("error", reject)
  })
  return child
}

async function stopChild(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
  child.kill("SIGKILL")
  await closed
}

describe("ProcessInspection", () => {
  test.skipIf(!supported)("samples distinct owned children and leaves terminated PIDs unmeasured", async () => {
    const children = await Promise.all([startChild(), startChild(), startChild()])
    try {
      const pids = children.map((child) => child.pid!)
      const samples = await ProcessInspection.rssBatch([...pids, pids[0], -1])
      expect(samples.size).toBe(3)
      for (const pid of pids) expect(samples.get(pid)).toBeGreaterThan(0)
      const identities = await ProcessInspection.sampleBatch(pids)
      expect(identities.size).toBe(3)
      expect((await ProcessInspection.sampleBatch(pids)).get(pids[0])?.identity).toBe(identities.get(pids[0])?.identity)
      expect(await ProcessInspection.rssBytes(pids[0])).toBeGreaterThan(0)
      await stopChild(children[0])
      expect(await ProcessInspection.rssBytes(pids[0])).toBeUndefined()
      expect((await ProcessInspection.rssBatch(pids)).has(pids[0])).toBe(false)
    } finally {
      await Promise.all(children.map(stopChild))
    }
  })

  test("constructs one Windows command and parses PID-tagged byte samples without coercing failures", () => {
    const command = rssCommand("win32", [41, 42])!
    expect(command.slice(0, 4)).toEqual(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"])
    expect(command[4]).toContain("Get-Process -Id 41,42 -ErrorAction SilentlyContinue")
    expect(command[4]).toContain("$_.WorkingSet64")
    expect(command[4]).toContain("$_.StartTime.ToUniversalTime().Ticks")
    expect([
      ...parseRssOutput(
        "win32",
        "41 8192 638953920000000000\r\n42 0 638953920000000001\r\n43 1024 638953920000000002\r\n41 NaN invalid\n",
        [41, 42],
      ),
    ]).toEqual([[41, { rssBytes: 8192, identity: "638953920000000000" }]])
    expect(parseRssOutput("win32", "Access denied\n41 8192 invalid", [41]).size).toBe(0)
  })

  test("parses macOS KiB and start identities, omitting malformed and absent PIDs", () => {
    expect(rssCommand("darwin", [41, 42])).toEqual(["ps", "-o", "pid=,rss=,lstart=", "-p", "41,42"])
    expect([
      ...parseRssOutput(
        "darwin",
        " 41 8 Wed Oct  7 08:30:00 2026\n42 0 Wed Oct  7 08:30:00 2026\n43 2 Wed Oct  7 08:30:00 2026",
        [41, 42],
      ),
    ]).toEqual([[41, { rssBytes: 8192, identity: "Wed Oct  7 08:30:00 2026" }]])
    expect(parseRssOutput("darwin", "41 8 invalid", [41]).size).toBe(0)
  })

  test.skipIf(process.platform !== "darwin")(
    "retains completed child batches at the deadline but discards them on caller abort, draining both",
    async () => {
      const children = await Promise.all([startChild(), startChild()])
      const directory = await mkdtemp(path.join(tmpdir(), "synergy-inspection-partial-"))
      const previousPath = process.env.PATH
      const socketPath = path.join(directory, "ready.sock")
      const fixturePath = path.join(directory, "partial.pl")
      let ready: (query: { pid: number; slow: boolean }) => void = () => {}
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
      const outcomes: Array<{ cancellation: string; samples: Map<number, number> }> = []
      try {
        for (const cancellation of ["deadline", "caller abort"]) {
          const controller = new AbortController()
          const started = Promise.withResolvers<void>()
          const commands: Array<{ pid: number; slow: boolean }> = []
          ready = (command) => {
            commands.push(command)
            if (commands.length === 2) started.resolve()
          }
          const pids = [
            children[0].pid!,
            ...Array.from({ length: 127 }, (_, index) => 2_147_483_647 - index),
            children[1].pid!,
          ]
          const before = performance.now()
          const query = ProcessInspection.rssBatch(pids, { signal: controller.signal })
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
            const samples = await query
            outcomes.push({ cancellation, samples })
            expect(performance.now() - before).toBeLessThan(2000)
            for (const command of commands) expect(ProcessInspection.alive(command.pid)).toBe(false)
          } finally {
            controller.abort()
            await query
          }
        }
        expect([...outcomes[0].samples]).toEqual([[children[0].pid!, 8192]])
        expect(outcomes[1].samples.size).toBe(0)
      } finally {
        if (previousPath === undefined) delete process.env.PATH
        else process.env.PATH = previousPath
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await Promise.all(children.map(stopChild))
        await rm(directory, { recursive: true, force: true })
      }
    },
  )

  test.skipIf(process.platform !== "darwin")(
    "delayed ps permits timer progress, batches PIDs, and drains deadline/cancelled queries",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "synergy-inspection-"))
      const previousPath = process.env.PATH
      const socketPath = path.join(directory, "ready.sock")
      const fixturePath = path.join(directory, "delayed.pl")
      let ready: (query: { pid: number; args: string[] }) => void = () => {}
      const server = createServer((socket) => {
        let payload = ""
        socket.on("data", (chunk) => {
          payload += chunk.toString()
        })
        socket.on("end", () => {
          const [pid, ...args] = payload.trim().split("\n")
          ready({ pid: Number(pid), args })
        })
      })
      await new Promise<void>((resolve) => server.listen(socketPath, resolve))
      await Bun.write(
        fixturePath,
        `use Socket; socket(S, PF_UNIX, SOCK_STREAM, 0) or die $!; connect(S, sockaddr_un(${JSON.stringify(socketPath)})) or die $!; print S join("\\n", $$, @ARGV), "\\n"; close(S); sleep 10;`,
      )
      const commandPath = path.join(directory, "ps")
      await Bun.write(commandPath, `#!/bin/sh\nexec /usr/bin/perl ${JSON.stringify(fixturePath)} "$@"\n`)
      await chmod(commandPath, 0o755)
      process.env.PATH = directory
      try {
        const started = new Promise<{ pid: number; args: string[] }>((resolve) => {
          ready = resolve
        })
        let settled = false
        const before = performance.now()
        const query = ProcessInspection.rssBatch([process.pid, process.pid + 1, process.pid]).then((samples) => {
          settled = true
          return samples
        })
        const execution = await Promise.race([
          started,
          query.then(() => {
            throw new Error("query ended before fixture readiness")
          }),
        ])
        expect(execution.args).toEqual(["-o", "pid=,rss=,lstart=", "-p", `${process.pid},${process.pid + 1}`])
        await new Promise<void>((resolve) => setTimeout(resolve, 10))
        expect(settled).toBe(false)
        expect((await query).size).toBe(0)
        expect(performance.now() - before).toBeLessThan(2000)
        expect(ProcessInspection.alive(execution.pid)).toBe(false)

        const controller = new AbortController()
        const nextStarted = new Promise<{ pid: number; args: string[] }>((resolve) => {
          ready = resolve
        })
        const cancelled = ProcessInspection.rssBatch([process.pid], { signal: controller.signal })
        const nextExecution = await Promise.race([
          nextStarted,
          cancelled.then(() => {
            throw new Error("query ended before fixture readiness")
          }),
        ])
        controller.abort()
        expect((await cancelled).size).toBe(0)
        expect(ProcessInspection.alive(nextExecution.pid)).toBe(false)
        ready = () => {
          throw new Error("pre-aborted query launched a command")
        }
        expect((await ProcessInspection.rssBatch([process.pid], { signal: controller.signal })).size).toBe(0)
      } finally {
        if (previousPath === undefined) delete process.env.PATH
        else process.env.PATH = previousPath
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await rm(directory, { recursive: true, force: true })
      }
    },
  )
})
