import { installedWorkerCommand, installedWorkerEnvironment } from "@ericsanchezok/synergy-util/installed-launcher"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import net from "node:net"
import { randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type { ProcessHandle } from "@ericsanchezok/synergy-harness/process/handle"
import type { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { DarwinCoalition } from "./darwin-coalition"
import { DarwinJob } from "./darwin-job"
import { WindowsJob } from "./windows-job"
import { LinuxTree } from "./linux-tree"
import { OwnedTree } from "./owned-tree"
import { OwnedProtocol } from "./owned-protocol"

export namespace OwnedProcess {
  class Child extends EventEmitter implements ProcessHandle {
    pid?: number
    readonly stdin = new PassThrough()
    readonly stdout = new PassThrough()
    readonly stderr = new PassThrough()
    exitCode: number | null = null
    signalCode: NodeJS.Signals | null = null
    stop: () => Promise<void> = async () => {}
    alive: () => boolean | undefined = () => undefined
    kill() {
      void this.stop().catch((error) => this.emit("error", error))
      return true
    }
  }
  export interface Input {
    command: string
    args: string[]
    cwd: string
    env: Record<string, string | undefined>
    lease: WorkspaceAccess.Lease
    signal?: AbortSignal
    pty?: { cols: number; rows: number; library: string }
  }
  function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: Error) => void
    const promise = new Promise<T>((yes, no) => {
      resolve = yes
      reject = no
    })
    void promise.catch(() => {})
    return { promise, resolve, reject }
  }
  export async function prepare(input: Input) {
    input.signal?.throwIfAborted()
    if (!["darwin", "win32", "linux"].includes(process.platform))
      throw new Error("Native process ownership is unavailable on this platform")
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sy-p-"))
    await fs.chmod(directory, 0o700)
    const socketPath = path.join(directory, "io")
    const token = randomBytes(32).toString("hex")
    const child = new Child()
    child.on("error", () => {})
    child.stdin.on("error", () => {})
    const sockets = new Map<string, net.Socket>()
    const accepted = new Set<net.Socket>()
    const drains: Promise<void>[] = []
    const connected = deferred<number>()
    const activated = deferred<void>()
    const complete = deferred<void>()
    let workerPID: number | undefined
    let reference: OwnedTree.Reference | undefined
    let job: Awaited<ReturnType<typeof DarwinJob.start>> | undefined
    let result: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null }
    let failure: Error | undefined
    let finished = false
    let exitAnnounced = false
    let errorAnnounced = false
    let controlClosed: Promise<void> | undefined
    let reported = false
    let started = false
    let stage = "preparing"
    let stopping: Promise<void> | undefined
    let observing: Promise<void> | undefined
    let abandoned: Promise<void> | undefined
    let startupTimer: ReturnType<typeof setTimeout> | undefined
    const fail = (error: Error) => {
      failure ??= error
      connected.reject(error)
      activated.reject(error)
      if (reference) void stop().catch(() => {})
    }
    const server = net.createServer((socket) => {
      accepted.add(socket)
      socket.on("close", () => accepted.delete(socket))
      socket.on("error", (error) => {
        if (sockets.has("control")) fail(error)
      })
      let pending = Buffer.alloc(0)
      const greeting = (chunk: Buffer) => {
        try {
          pending = Buffer.concat([pending, chunk])
          const end = pending.indexOf(10)
          if (end < 0) {
            if (pending.length > 8192) throw new Error("Invalid native process greeting")
            return
          }
          if (end > 8192) throw new Error("Invalid native process greeting")
          socket.pause()
          socket.off("data", greeting)
          const message = OwnedProtocol.Greeting.parse(JSON.parse(pending.subarray(0, end).toString()))
          if (message.token !== token || sockets.has(message.channel) || (workerPID && workerPID !== message.pid)) {
            socket.destroy()
            return
          }
          workerPID = message.pid
          sockets.set(message.channel, socket)
          const rest = pending.subarray(end + 1)
          if (rest.length) socket.unshift(rest)
          if (message.channel === "control") {
            controlClosed = new Promise<void>((resolve) => socket.once("end", resolve).once("close", resolve))
            OwnedProtocol.messages(
              socket,
              (raw) => {
                const event = OwnedProtocol.Event.parse(raw)
                if (event.type === "stage") stage = event.stage
                if (event.type === "ready") {
                  child.pid = event.pid
                  activated.resolve()
                }
                if (event.type === "exit") {
                  reported = true
                  if (!stopping) result = { code: event.code, signal: event.signal as NodeJS.Signals | null }
                }
                if (event.type === "error") fail(new Error(event.message))
              },
              fail,
            )
          }
          if (message.channel === "stdin") {
            let bytes = 0
            child.stdin.pipe(socket, { end: false })
            child.stdin.on("data", (chunk: Buffer) => {
              bytes += chunk.length
            })
            child.stdin.once("end", () => {
              const control = sockets.get("control")
              if (control && !control.destroyed && !control.writableEnded)
                OwnedProtocol.send(control, { type: "stdin-end", bytes })
            })
            socket.on("close", () => child.stdin.destroy())
          }
          if (message.channel === "stdout" || message.channel === "stderr") {
            drains.push(new Promise<void>((resolve) => socket.once("end", resolve).once("close", resolve)))
            const stream = message.channel === "stdout" ? child.stdout : child.stderr
            drains.push(new Promise<void>((resolve) => stream.once("end", resolve).once("close", resolve)))
            stream.once("close", () => {
              socket.unpipe(stream)
              socket.resume()
            })
            socket.pipe(stream)
          }
          socket.resume()
          if (sockets.size === 4) connected.resolve(workerPID)
        } catch (error) {
          socket.destroy()
          fail(error instanceof Error ? error : new Error(String(error)))
        }
      }
      socket.on("data", greeting)
    })
    async function cleanup() {
      clearTimeout(startupTimer)
      input.signal?.removeEventListener("abort", abort)
      for (const socket of accepted) socket.destroy()
      server.close()
      await job?.remove()
      await input.lease.release()
      await fs.rm(directory, { recursive: true, force: true })
    }
    function abandon() {
      return (abandoned ??= (async () => {
        clearTimeout(startupTimer)
        input.signal?.removeEventListener("abort", abort)
        for (const socket of accepted) socket.destroy()
        server.close()
        child.stdin.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
        await job?.remove()
        await input.lease.release()
      })())
    }
    function announceError() {
      if (!failure || errorAnnounced) return
      errorAnnounced = true
      child.emit("error", failure)
    }
    function announceExit() {
      if (exitAnnounced) return
      exitAnnounced = true
      child.exitCode = result.code
      child.signalCode = result.signal
      child.emit("exit", result.code, result.signal)
    }
    async function finish() {
      if (finished) return
      finished = true
      try {
        await cleanup()
        activated.reject(new Error("Native process exited before activation completed"))
        child.stdin.destroy()
        child.stdout.end()
        child.stderr.end()
        announceError()
        announceExit()
        child.emit("close", result.code, result.signal)
        complete.resolve()
      } catch (error) {
        const value = error instanceof Error ? error : new Error(String(error))
        complete.reject(value)
        child.emit("error", value)
      }
    }
    async function observe() {
      try {
        while (reference && OwnedTree.inspect(reference).state === "active") await Bun.sleep(25)
        await controlClosed
        if (!reported && !stopping)
          failure ??= new Error("Native process supervisor exited without a completion record")
        announceError()
        await Promise.all(drains)
        await finish()
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error(String(error))
        complete.reject(failure)
        child.emit("error", failure)
        await abandon()
      }
    }
    async function stop() {
      if (finished) return complete.promise
      return (stopping ??= (async () => {
        result = { code: null, signal: "SIGTERM" }
        if (reference) {
          OwnedTree.terminate(reference)
          const until = Date.now() + 5000
          await Bun.sleep(200)
          while (!finished && OwnedTree.inspect(reference).state === "active") {
            OwnedTree.terminate(reference, "SIGKILL")
            if (Date.now() >= until) throw new Error("Native process descendants have not exited")
            await Bun.sleep(25)
          }
        }
        if (observing) {
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([
              observing,
              new Promise<void>((resolve) => {
                timer = setTimeout(() => {
                  child.stdout.destroy()
                  child.stderr.destroy()
                  resolve()
                }, 1500)
              }),
            ])
            await observing
          } finally {
            clearTimeout(timer)
          }
        } else await finish()
      })().catch(async (error) => {
        await abandon()
        throw error
      }))
    }
    const abort = () => {
      fail(input.signal?.reason instanceof Error ? input.signal.reason : new Error("Native process launch cancelled"))
    }
    child.stop = stop
    child.alive = () => {
      if (finished) return false
      if (!reference) return undefined
      try {
        return OwnedTree.inspect(reference).state === "active"
      } catch {
        return undefined
      }
    }
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        if (process.platform === "win32") server.listen(0, "127.0.0.1", resolve)
        else server.listen(socketPath, resolve)
      })
      if (process.platform !== "win32") await fs.chmod(socketPath, 0o600)
      const address = server.address()
      const transport =
        process.platform === "win32" && address && typeof address !== "string"
          ? { host: "127.0.0.1" as const, port: address.port }
          : socketPath
      const filename = path.join(directory, "input.json")
      const configuration: OwnedProtocol.Configuration = {
        socket: transport,
        token,
        deadline: Date.now() + 30000,
        ownerCoalition: process.platform === "darwin" ? DarwinCoalition.current() : undefined,
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        pty: input.pty,
        env: Object.fromEntries(
          Object.entries(input.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
      }
      await fs.writeFile(filename, JSON.stringify(configuration), { mode: 0o600 })
      const source = fileURLToPath(new URL("./owned-worker.ts", import.meta.url))
      const command =
        installedWorkerCommand(process.env, "__owned-process-runner", [filename]) ??
        (existsSync(source)
          ? [process.execPath, "run", source, filename]
          : [process.execPath, "__owned-process-runner", filename])
      startupTimer = setTimeout(() => fail(new Error("Native process startup timed out")), 30000)
      input.signal?.addEventListener("abort", abort, { once: true })
      input.signal?.throwIfAborted()
      job =
        process.platform === "darwin"
          ? await DarwinJob.start(command, directory, installedWorkerEnvironment(process.env))
          : process.platform === "win32"
            ? await WindowsJob.start(command, directory)
            : await LinuxTree.start(command, directory)
      const pid = await connected.promise
      void Promise.all(drains)
        .then(() => {
          const control = sockets.get("control")
          if (!stopping && control && !control.destroyed && !control.readableEnded && !control.writableEnded)
            OwnedProtocol.send(control, { type: "drained" })
        })
        .catch(fail)
      reference = OwnedTree.capture(pid)
      await input.lease.bindProcess(pid, { descendants: true })
      input.signal?.throwIfAborted()
      clearTimeout(startupTimer)
      observing = observe()
      void observing.catch(fail)
      return {
        child,
        diagnostics() {
          return {
            stage,
            tree: reference && !finished ? OwnedTree.inspect(reference) : undefined,
            control: {
              ended: sockets.get("control")?.readableEnded,
              finished: sockets.get("control")?.writableFinished,
              closed: sockets.get("control")?.closed,
            },
            stdout: { ended: child.stdout.readableEnded, bytes: child.stdout.readableLength },
            stderr: { ended: child.stderr.readableEnded, bytes: child.stderr.readableLength },
          }
        },
        async activate() {
          if (started || finished || stopping) throw new Error("Native process is no longer awaiting activation")
          started = true
          input.signal?.throwIfAborted()
          OwnedProtocol.send(sockets.get("control")!, { type: "activate" })
          await activated.promise
          input.signal?.removeEventListener("abort", abort)
        },
        stop,
        resize(cols: number, rows: number) {
          if (!input.pty || !started || finished || stopping) throw new Error("Native PTY is not running")
          OwnedProtocol.send(sockets.get("control")!, OwnedProtocol.Control.parse({ type: "resize", cols, rows }))
        },
        completion: complete.promise,
      }
    } catch (error) {
      if (reference) await stop()
      else await cleanup()
      throw error
    }
  }
}
