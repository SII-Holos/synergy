import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { type IPty } from "bun-pty"
import z from "zod"
import { Identifier } from "../id/id"
import { Log } from "../util/log"
import type { WSContext } from "hono/ws"
import { ScopeContext } from "../scope/context"
import { ScopedState } from "../scope/scoped-state"
import { lazy } from "@ericsanchezok/synergy-util/lazy"
import { Shell } from "@/util/shell"
import { PerformanceMetrics } from "@/performance/metrics"
import { PerformanceRedaction } from "@/performance/redact"

export namespace Pty {
  const log = Log.create({ service: "pty" })

  const BUFFER_LIMIT = 1024 * 1024 * 2
  const BUFFER_CHUNK = 64 * 1024

  const pty = lazy(async () => {
    const { spawn } = await import("bun-pty")
    return spawn
  })

  export const Info = z
    .object({
      id: Identifier.schema("pty"),
      title: z.string(),
      command: z.string(),
      args: z.array(z.string()),
      cwd: z.string(),
      status: z.enum(["running", "exited"]),
      pid: z.number(),
    })
    .meta({ ref: "Pty" })

  export type Info = z.infer<typeof Info>

  export const CreateInput = z.object({
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    title: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
  })

  export type CreateInput = z.infer<typeof CreateInput>

  export const UpdateInput = z.object({
    title: z.string().optional(),
    size: z
      .object({
        rows: z.number(),
        cols: z.number(),
      })
      .optional(),
  })

  export type UpdateInput = z.infer<typeof UpdateInput>

  export const Event = {
    Created: BusEvent.define("pty.created", z.object({ info: Info })),
    Updated: BusEvent.define("pty.updated", z.object({ info: Info })),
    Exited: BusEvent.define("pty.exited", z.object({ id: Identifier.schema("pty"), exitCode: z.number() })),
    Deleted: BusEvent.define("pty.deleted", z.object({ id: Identifier.schema("pty") })),
  }

  interface ActiveSession {
    info: Info
    process: IPty
    buffer: string
    subscribers: Set<WSContext>
    outputBytes: number
    outputTimer?: ReturnType<typeof setTimeout>
  }

  const state = ScopedState.create(
    () => new Map<string, ActiveSession>(),
    async (sessions) => {
      for (const session of sessions.values()) {
        try {
          session.process.kill()
        } catch {}
        for (const ws of session.subscribers) {
          ws.close()
        }
      }
      sessions.clear()
    },
  )

  export function list() {
    return Array.from(state().values()).map((s) => s.info)
  }

  export function get(id: string) {
    return state().get(id)?.info
  }

  export async function create(input: CreateInput) {
    const id = Identifier.create("pty", false)
    const command = input.command || Shell.preferred()
    const args = input.args || []
    if (command.endsWith("sh")) {
      args.push("-l")
    }

    const cwd = input.cwd || ScopeContext.current.directory
    const env = { ...process.env, ...input.env, TERM: "xterm-256color" } as Record<string, string>
    log.info("creating session", { id, cmd: command, args, cwd })

    const spawn = await pty()
    const ptyProcess = spawn(command, args, {
      name: "xterm-256color",
      cwd,
      env,
    })

    const startTime = Date.now()
    const info = {
      id,
      title: input.title || `Terminal ${id.slice(-4)}`,
      command,
      args,
      cwd,
      status: "running",
      pid: ptyProcess.pid,
    } as const
    const session: ActiveSession = {
      info,
      process: ptyProcess,
      buffer: "",
      subscribers: new Set(),
      outputBytes: 0,
    }
    PerformanceMetrics.record({
      name: "pty.session.created",
      value: 1,
      unit: "count",
      module: "pty",
      source: "process",
      processId: id,
      pid: ptyProcess.pid,
      labels: { cwdScope: PerformanceRedaction.cwdScope(cwd), command: PerformanceRedaction.commandFamily(command) },
    })
    state().set(id, session)
    ptyProcess.onData((data: string) => {
      session.outputBytes += Buffer.byteLength(data)
      if (!session.outputTimer) {
        session.outputTimer = setTimeout(() => {
          const value = session.outputBytes
          session.outputBytes = 0
          session.outputTimer = undefined
          PerformanceMetrics.record({
            name: "pty.output.bytes",
            value,
            unit: "bytes",
            module: "pty",
            source: "process",
            processId: id,
            pid: ptyProcess.pid,
            labels: { subscribers: session.subscribers.size },
          })
        }, 1000)
        session.outputTimer.unref()
      }
      let open = false
      for (const ws of session.subscribers) {
        if (ws.readyState !== 1) {
          session.subscribers.delete(ws)
          continue
        }
        open = true
        try {
          ws.send(data)
        } catch {
          session.subscribers.delete(ws)
          PerformanceMetrics.record({
            name: "pty.websocket.write_failure",
            value: 1,
            unit: "count",
            module: "pty",
            source: "process",
            processId: id,
            pid: ptyProcess.pid,
          })
        }
      }
      if (open) return
      session.buffer += data
      if (session.buffer.length <= BUFFER_LIMIT) return
      session.buffer = session.buffer.slice(-BUFFER_LIMIT)
    })
    const flushOutputBytes = () => {
      if (session.outputTimer) clearTimeout(session.outputTimer)
      session.outputTimer = undefined
      if (!session.outputBytes) return
      const value = session.outputBytes
      session.outputBytes = 0
      PerformanceMetrics.record({
        name: "pty.output.bytes",
        value,
        unit: "bytes",
        module: "pty",
        source: "process",
        processId: id,
        pid: ptyProcess.pid,
        labels: { subscribers: session.subscribers.size },
      })
    }
    ptyProcess.onExit(({ exitCode }) => {
      log.info("session exited", { id, exitCode })
      session.info.status = "exited"
      flushOutputBytes()
      Bus.publish(Event.Exited, { id, exitCode })
      PerformanceMetrics.record({
        name: "pty.session.duration",
        value: Date.now() - startTime,
        unit: "ms",
        module: "pty",
        source: "process",
        processId: id,
        pid: ptyProcess.pid,
        labels: { exitCode },
      })
      state().delete(id)
    })
    Bus.publish(Event.Created, { info })
    return info
  }

  export async function update(id: string, input: UpdateInput) {
    const session = state().get(id)
    if (!session) return
    if (input.title) {
      session.info.title = input.title
    }
    if (input.size) {
      session.process.resize(input.size.cols, input.size.rows)
    }
    Bus.publish(Event.Updated, { info: session.info })
    return session.info
  }

  export async function remove(id: string) {
    const session = state().get(id)
    if (!session) return
    log.info("removing session", { id })
    try {
      if (session.outputTimer) clearTimeout(session.outputTimer)
      session.process.kill()
    } catch {}
    for (const ws of session.subscribers) {
      ws.close()
    }
    state().delete(id)
    Bus.publish(Event.Deleted, { id })
  }

  export function resize(id: string, cols: number, rows: number) {
    const session = state().get(id)
    if (session && session.info.status === "running") {
      session.process.resize(cols, rows)
    }
  }

  export function write(id: string, data: string) {
    const session = state().get(id)
    if (session && session.info.status === "running") {
      PerformanceMetrics.record({
        name: "pty.input.bytes",
        value: Buffer.byteLength(data),
        unit: "bytes",
        module: "pty",
        source: "process",
        processId: id,
        pid: session.info.pid,
      })
      session.process.write(data)
    }
  }

  export function connect(id: string, ws: WSContext) {
    const session = state().get(id)
    if (!session) {
      ws.close()
      return
    }
    log.info("client connected to session", { id })
    session.subscribers.add(ws)
    const connectedAt = Date.now()
    PerformanceMetrics.record({
      name: "pty.websocket.connection.open",
      value: 1,
      unit: "count",
      module: "pty",
      source: "process",
      processId: id,
      pid: session.info.pid,
    })
    if (session.buffer) {
      const buffer = session.buffer.length <= BUFFER_LIMIT ? session.buffer : session.buffer.slice(-BUFFER_LIMIT)
      session.buffer = ""
      try {
        for (let i = 0; i < buffer.length; i += BUFFER_CHUNK) {
          ws.send(buffer.slice(i, i + BUFFER_CHUNK))
        }
      } catch {
        session.subscribers.delete(ws)
        session.buffer = buffer
        ws.close()
        PerformanceMetrics.record({
          name: "pty.websocket.write_failure",
          value: 1,
          unit: "count",
          module: "pty",
          source: "process",
          processId: id,
          pid: session.info.pid,
          labels: { phase: "buffer_replay" },
        })
        return
      }
    }
    return {
      onMessage: (message: string | ArrayBuffer) => {
        PerformanceMetrics.record({
          name: "pty.input.bytes",
          value: typeof message === "string" ? Buffer.byteLength(message) : message.byteLength,
          unit: "bytes",
          module: "pty",
          source: "process",
          processId: id,
          pid: session.info.pid,
          labels: { via: "websocket" },
        })
        session.process.write(String(message))
      },
      onClose: () => {
        log.info("client disconnected from session", { id })
        session.subscribers.delete(ws)
        PerformanceMetrics.record({
          name: "pty.websocket.connection.duration",
          value: Date.now() - connectedAt,
          unit: "ms",
          module: "pty",
          source: "process",
          processId: id,
          pid: session.info.pid,
        })
      },
    }
  }
}
