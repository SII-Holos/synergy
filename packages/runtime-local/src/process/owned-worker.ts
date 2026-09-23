import fs from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { DarwinJob } from "./darwin-job"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { OwnedTree } from "./owned-tree"
import { LinuxTree } from "./linux-tree"
import { OwnedProtocol } from "./owned-protocol"
import { NativePty } from "./native-pty"
import type { Writable } from "node:stream"

export async function runOwnedProcessWorker(filename: string) {
  const raw = await fs.readFile(filename)
  if (raw.length > 16 * 1024 * 1024) throw new Error("Native process configuration exceeds its bound")
  const config = OwnedProtocol.Configuration.parse(JSON.parse(raw.toString()))
  if (process.platform === "linux") LinuxTree.initializeWorker(path.dirname(filename))
  let reference = process.platform !== "win32" ? OwnedTree.current() : undefined
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
    const socket =
      typeof config.socket === "string"
        ? net.createConnection(config.socket)
        : net.createConnection(config.socket.port, config.socket.host)
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
      if (!OwnedTree.hasDescendants(reference)) break
      OwnedTree.terminateDescendants(reference, "SIGKILL")
      if (Date.now() >= until) break
      await Bun.sleep(25)
    }
    if (process.platform === "darwin") await DarwinJob.releaseDisconnectedWorker(path.dirname(filename)).catch(() => {})
    else if (process.platform === "win32")
      await fs.rm(path.dirname(filename), { recursive: true, force: true }).catch(() => {})
    else if (reference) OwnedTree.complete(reference)
    process.exit(1)
  }
  if (process.platform === "linux") process.on("SIGTERM", () => void shutdown())
  for (const socket of [control, input, output, error]) socket.on("error", () => void shutdown())
  control.once("close", () => void shutdown())
  let terminal: ReturnType<typeof NativePty.spawn> | undefined
  let activationReceived = false
  const received = Promise.withResolvers<void>()
  let receivedInput = 0
  let inputEnd: number | undefined
  let commandInput: Writable | undefined
  const finishInput = () => {
    if (inputEnd === receivedInput) commandInput?.end()
  }
  const activated = new Promise<void>((resolve, reject) => {
    OwnedProtocol.messages(
      control,
      (raw) => {
        const message = OwnedProtocol.Control.parse(raw)
        if (message.type === "activate" && !activationReceived) {
          activationReceived = true
          resolve()
        } else if (message.type === "drained" && activationReceived) {
          received.resolve()
        } else if (message.type === "stdin-end" && inputEnd === undefined) {
          inputEnd = message.bytes
          finishInput()
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
    commandInput = child.stdin
    input.pipe(child.stdin, { end: false })
    input.on("data", (chunk: Buffer) => {
      receivedInput += chunk.length
      finishInput()
    })
    finishInput()
    child.stdout.pipe(output)
    if ("stderr" in child) child.stderr.pipe(error)
    else error.end()
    child.stdin.on("error", () => input.destroy())
    if (!("exited" in child)) await once(child, "spawn")
    OwnedProtocol.send(control, { type: "ready", pid: child.pid })
    OwnedProtocol.send(control, { type: "stage", stage: "launched" })
    const result = await exited
    OwnedProtocol.send(control, { type: "stage", stage: "root-exited" })
    terminal?.close()
    while (OwnedTree.hasDescendants(reference)) await Bun.sleep(25)
    OwnedProtocol.send(control, { type: "stage", stage: "tree-drained" })
    await Promise.all([
      child.stdout.readableEnded ? Promise.resolve() : once(child.stdout, "end"),
      !("stderr" in child) || child.stderr.readableEnded ? Promise.resolve() : once(child.stderr, "end"),
    ])
    await Promise.all(drained)
    OwnedProtocol.send(control, { type: "stage", stage: "streams-drained" })
    await received.promise
    OwnedTree.complete(reference)
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
