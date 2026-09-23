import fs from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { DarwinJob } from "./darwin-job"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { OwnedTree } from "./owned-tree"
import { OwnedProtocol } from "./owned-protocol"
import { NativePty } from "./native-pty"

export async function runOwnedProcessWorker(filename: string) {
  const raw = await fs.readFile(filename)
  if (raw.length > 16 * 1024 * 1024) throw new Error("Native process configuration exceeds its bound")
  const config = OwnedProtocol.Configuration.parse(JSON.parse(raw.toString()))
  let reference = process.platform === "darwin" ? OwnedTree.current() : undefined
  if (
    reference?.kind === "darwin-coalition" &&
    (!config.ownerCoalition ||
      reference.bootID !== config.ownerCoalition.bootID ||
      reference.coalitionID === config.ownerCoalition.coalitionID)
  )
    throw new Error("Native process worker must run independently of its owner")
  await fs.unlink(filename)
  if (Date.now() >= config.deadline) throw new Error("Native process activation expired")
  const connect = async (channel: "control" | "stdin" | "stdout" | "stderr") => {
    const socket = net.createConnection(config.socket)
    await once(socket, "connect")
    OwnedProtocol.send(socket, { token: config.token, channel, pid: process.pid })
    return socket
  }
  const [control, input, output, error] = await Promise.all([
    connect("control"),
    connect("stdin"),
    connect("stdout"),
    connect("stderr"),
  ])
  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    if (reference) OwnedTree.terminateDescendants(reference, "SIGTERM")
    await Bun.sleep(200)
    const until = Date.now() + 5000
    while (reference) {
      const active = OwnedTree.inspect(reference)
      if (active.state === "exited" || active.processes <= 1) break
      OwnedTree.terminateDescendants(reference, "SIGKILL")
      if (Date.now() >= until) break
      await Bun.sleep(25)
    }
    if (process.platform === "darwin") await DarwinJob.releaseDisconnectedWorker(path.dirname(filename)).catch(() => {})
    else await fs.rm(path.dirname(filename), { recursive: true, force: true }).catch(() => {})
    process.exit(1)
  }
  for (const socket of [control, input, output, error]) socket.on("error", () => void shutdown())
  control.once("close", () => void shutdown())
  let terminal: ReturnType<typeof NativePty.spawn> | undefined
  let activationReceived = false
  const activated = new Promise<void>((resolve, reject) => {
    OwnedProtocol.messages(
      control,
      (raw) => {
        const message = OwnedProtocol.Control.parse(raw)
        if (message.type === "activate" && !activationReceived) {
          activationReceived = true
          resolve()
        } else if (message.type === "resize" && terminal) terminal.resize(message.cols, message.rows)
        else throw new Error("Invalid native process control state")
      },
      (error) => {
        reject(error)
        void shutdown()
      },
    )
  })
  const activationTimer = setTimeout(() => void shutdown(), Math.max(1, config.deadline - Date.now()))
  try {
    await activated
    reference ??= OwnedTree.current()
    clearTimeout(activationTimer)
    const child = config.pty
      ? (terminal = NativePty.spawn({ ...config, ...config.pty }))
      : spawn(config.command, config.args, {
          cwd: config.cwd,
          env: config.env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          windowsVerbatimArguments:
            process.platform === "win32" &&
            ["cmd", "cmd.exe"].includes(path.win32.basename(config.command).toLowerCase()),
        })
    const exited =
      "exited" in child
        ? child.exited.then((code) => ({ code, signal: null }))
        : new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
            child.once("error", reject)
            child.once("exit", (code, signal) => resolve({ code, signal }))
          })
    const drained = [output, error].map((socket) => new Promise<void>((resolve) => socket.once("finish", resolve)))
    void exited.catch(() => {})
    input.pipe(child.stdin)
    child.stdout.pipe(output)
    if ("stderr" in child) child.stderr.pipe(error)
    else error.end()
    child.stdin.on("error", () => input.destroy())
    if (!("exited" in child)) await once(child, "spawn")
    OwnedProtocol.send(control, { type: "ready", pid: child.pid })
    const result = await exited
    terminal?.close()
    for (;;) {
      const live = OwnedTree.inspect(reference)
      if (live.state === "exited" || live.processes === 1) break
      await Bun.sleep(25)
    }
    await Promise.all([
      child.stdout.readableEnded ? Promise.resolve() : once(child.stdout, "end"),
      !("stderr" in child) || child.stderr.readableEnded ? Promise.resolve() : once(child.stderr, "end"),
    ])
    await Promise.all(drained)
    stopping = true
    OwnedProtocol.send(control, { type: "exit", ...result })
    await new Promise<void>((resolve) => control.end(resolve))
    input.destroy()
    output.end()
    error.end()
  } catch (failure) {
    OwnedProtocol.send(control, {
      type: "error",
      message: failure instanceof Error ? failure.message : String(failure),
    })
    await shutdown()
  } finally {
    clearTimeout(activationTimer)
    terminal?.close()
  }
}

if (import.meta.main) {
  await runOwnedProcessWorker(process.argv[2]!)
  process.exit(0)
}
