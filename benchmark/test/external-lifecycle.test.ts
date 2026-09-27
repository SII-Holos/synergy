import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const cleanups = new Set<() => Promise<void>>()

afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error
    return false
  }
}

function accepting(port: number, signal: AbortSignal) {
  return new Promise<boolean>((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port, signal })
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once("error", (error) => {
      socket.destroy()
      if ("code" in error && error.code === "ECONNREFUSED") resolve(false)
      else reject(error)
    })
  })
}

test.each(["normal", "SIGTERM", "SIGINT"] as const)(
  "the external wrapper exits after native exit and observer drain: %s",
  async (mode) => {
    const signal = mode === "normal" ? null : mode
    const root = await mkdtemp(path.join(os.tmpdir(), "bench-external-drain-"))
    const logs = path.join(root, "logs")
    const pidFile = path.join(root, "native.pid")
    const marker = path.join(root, "started.json")
    const arrived = Promise.withResolvers<void>()
    const ready = Promise.withResolvers<{ pid: number; relay: string }>()
    const release = Promise.withResolvers<void>()
    const disposed = new AbortController()
    let child: Bun.Subprocess | undefined
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === "/ready") {
          const observed = await request.json()
          await arrived.promise
          ready.resolve(observed)
          return new Response("ready")
        }
        arrived.resolve()
        await release.promise
        return Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1 } })
      },
    })
    cleanups.add(async () => {
      disposed.abort()
      release.resolve()
      if (await Bun.file(pidFile).exists()) {
        const pid = Number(await Bun.file(pidFile).text())
        if (alive(pid)) process.kill(-pid, "SIGKILL")
      }
      if (child?.exitCode === null) child.kill("SIGKILL")
      await child?.exited
      await provider.stop(true)
      await rm(root, { recursive: true, force: true })
    })
    await writeFile(
      path.join(root, "native.mjs"),
      `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid));
await Bun.write(${JSON.stringify(marker)}, JSON.stringify({started_at:Date.now()}));
void fetch(process.env.BENCH_GATEWAY_BASE + "/chat/completions", {method:"POST",body:"{}"}).catch(() => {});
await fetch(${JSON.stringify(new URL("/ready", provider.url).href)}, {
  method:"POST", body:JSON.stringify({pid:process.pid,relay:process.env.BENCH_CAPTURE_ENDPOINT})
});
console.log(JSON.stringify({type:"step_finish",part:{reason:"stop"}}));
process.exit(0);`,
    )
    await writeFile(path.join(root, "instruction.md"), "Observe native process cleanup")
    await writeFile(path.join(root, "credentials.json"), "{}", { mode: 0o600 })
    await writeFile(
      path.join(root, "options.json"),
      JSON.stringify({
        harness: "synergy",
        runtime_protocol: "synergy-session-v1",
        native: {
          argv: [process.execPath, path.join(root, "native.mjs")],
          files: {},
          env: {
            SYNERGY_HOME: path.join(logs, "home"),
            BENCH_GATEWAY_BASE: new URL("/v1", provider.url).href,
            BUN_OPTIONS: `--preload=${path.resolve(import.meta.dir, "../runtime/session-capture.mjs")}`,
          },
        },
        execution_marker: marker,
        startup_timeout_seconds: 60,
        timeout_seconds: 60,
        cleanup_seconds: 60,
        export_timeout_seconds: 60,
      }),
    )
    const running = Bun.spawn(
      [
        process.execPath,
        path.resolve(import.meta.dir, "../runtime/external.mjs"),
        path.join(root, "options.json"),
        path.join(root, "instruction.md"),
        logs,
        path.join(root, "credentials.json"),
      ],
      {
        env: { PATH: process.env.PATH, HOME: path.join(root, "task-home"), NO_PROXY: "127.0.0.1,localhost" },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    child = running
    const stdout = new Response(running.stdout).text()
    const stderr = new Response(running.stderr).text()
    const observed = await Promise.race([
      ready.promise,
      running.exited.then(async (code) => {
        throw new Error(`Wrapper exited before native readiness: ${code}\n${await stderr}`)
      }),
    ])
    async function until(check: () => boolean | Promise<boolean>) {
      while (!(await check())) {
        disposed.signal.throwIfAborted()
        if (running.exitCode !== null) throw new Error(`Wrapper exited before the drain barrier: ${await stderr}`)
        await Bun.sleep(10)
      }
    }
    await until(() => !alive(observed.pid))
    await until(async () => !(await accepting(Number(new URL(observed.relay).port), disposed.signal)))
    expect(await Bun.file(path.join(logs, "execution.json")).exists()).toBe(false)
    if (signal) running.kill(signal)
    else release.resolve()

    await until(() => Bun.file(path.join(logs, "finished")).exists())
    expect(await Bun.file(path.join(logs, "execution.json")).json()).toMatchObject({
      exit_code: 0,
      outcome: signal ? "cancelled" : "completed",
      native_terminal: { status: "completed" },
      interrupted: signal !== null,
      forced: false,
      capture_cleanup: { timed_out: false },
    })
    const wire = path.join(logs, "home/native-wire")
    const entries = await readdir(wire)
    expect(entries).toHaveLength(1)
    expect(await Bun.file(path.join(wire, entries[0], "request.json")).json()).toMatchObject({
      status: signal ? "interrupted" : "completed",
      usage: signal ? null : { prompt_tokens: 1, completion_tokens: 1 },
    })
    expect(await running.exited).toBe(signal ? 1 : 0)
    expect(await stdout).toBe("")
    expect(await stderr).toBe("")
    expect(alive(observed.pid)).toBe(false)
    expect(alive(running.pid)).toBe(false)
  },
  15000,
)
