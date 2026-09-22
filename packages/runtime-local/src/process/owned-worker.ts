import fs from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { DarwinJob } from "./darwin-job"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { DarwinCoalition } from "./darwin-coalition"
import { OwnedProtocol } from "./owned-protocol"

export async function runOwnedProcessWorker(filename: string) {
  const raw = await fs.readFile(filename)
  if (raw.length > 16 * 1024 * 1024) throw new Error("Native process configuration exceeds its bound")
  const config = OwnedProtocol.Configuration.parse(JSON.parse(raw.toString()))
  const reference = DarwinCoalition.current()
  if (reference.bootID !== config.ownerCoalition.bootID || reference.coalitionID === config.ownerCoalition.coalitionID)
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
    DarwinCoalition.terminateDescendants("SIGTERM")
    await Bun.sleep(200)
    const until = Date.now() + 5000
    for (;;) {
      const active = DarwinCoalition.inspect(reference)
      if (active.state === "exited" || active.processes <= 1) break
      DarwinCoalition.terminateDescendants("SIGKILL")
      if (Date.now() >= until) break
      await Bun.sleep(25)
    }
    await DarwinJob.releaseDisconnectedWorker(path.dirname(filename)).catch(() => {})
    process.exit(1)
  }
  for (const socket of [control, input, output, error]) socket.on("error", () => void shutdown())
  control.once("close", () => void shutdown())
  const activated = new Promise<void>((resolve, reject) => {
    OwnedProtocol.messages(
      control,
      (message) => {
        if (message && typeof message === "object" && "type" in message && message.type === "activate") resolve()
        else reject(new Error("Invalid native process activation"))
      },
      reject,
    )
  })
  const activationTimer = setTimeout(() => void shutdown(), Math.max(1, config.deadline - Date.now()))
  try {
    await activated
    clearTimeout(activationTimer)
    const child = spawn(config.command, config.args, {
      cwd: config.cwd,
      env: config.env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) => resolve({ code, signal }))
    })
    const drained = [output, error].map((socket) => new Promise<void>((resolve) => socket.once("finish", resolve)))
    void exited.catch(() => {})
    input.pipe(child.stdin)
    child.stdout.pipe(output)
    child.stderr.pipe(error)
    child.stdin.on("error", () => input.destroy())
    await once(child, "spawn")
    OwnedProtocol.send(control, { type: "ready", pid: child.pid })
    const result = await exited
    for (;;) {
      const live = DarwinCoalition.inspect(reference)
      if (live.state === "exited" || live.processes === 1) break
      await Bun.sleep(25)
    }
    await Promise.all([
      child.stdout.readableEnded ? Promise.resolve() : once(child.stdout, "end"),
      child.stderr.readableEnded ? Promise.resolve() : once(child.stderr, "end"),
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
  }
}

if (import.meta.main) {
  await runOwnedProcessWorker(process.argv[2]!)
  process.exit(0)
}
