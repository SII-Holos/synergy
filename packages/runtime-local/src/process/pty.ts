import { AsyncLocalStorage } from "node:async_hooks"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { BusEvent } from "@ericsanchezok/synergy-harness/bus/bus-event"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { z } from "zod"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { ScopedState } from "@ericsanchezok/synergy-harness/scope/scoped-state"
import { Shell } from "@ericsanchezok/synergy-harness/util/shell"
import { WorkspaceState } from "@ericsanchezok/synergy-harness/workspace/state"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { NativePty } from "./native-pty"
import { OwnedProcess } from "./owned-process"
import { once } from "node:events"
import { ObservabilityMetrics } from "@ericsanchezok/synergy-harness/observability/metrics"
import { ObservabilityRedaction } from "@ericsanchezok/synergy-harness/observability/redaction"

export namespace Pty {
  export interface Client {
    readyState: number
    bufferedAmount?: number
    send(data: string): void
    close(): void
  }
  const log = Log.create({ service: "pty" })

  const BUFFER_LIMIT = 1024 * 1024 * 2
  const BUFFER_CHUNK = 64 * 1024

  async function spawn(input: NativePty.Input, signal: AbortSignal) {
    signal.throwIfAborted()
    const lease = await WorkspaceAccess.process(null, signal)
    const owned = await OwnedProcess.prepare({
      ...input,
      lease,
      signal,
      pty: { cols: input.cols ?? 80, rows: input.rows ?? 24, library: NativePty.libraryPath() },
    })
    owned.child.stderr.resume()
    try {
      await owned.activate()
      signal.throwIfAborted()
    } catch (error) {
      await owned.stop()
      throw error
    }
    return {
      pid: owned.child.pid!,
      input: owned.child.stdin,
      output: owned.child.stdout,
      completed: owned.completion.then(() => owned.child.exitCode ?? 1),
      stop: owned.stop,
      resize: owned.resize,
    }
  }

  export const Info = z
    .object({
      id: Identifier.schema("pty"),
      sessionID: Identifier.schema("session").optional(),
      title: z.string(),
      command: z.string(),
      args: z.array(z.string()),
      cwd: z.string(),
      workspaceID: z.string().startsWith("wsp_"),
      workspaceGeneration: z.number().int().positive(),
      status: z.enum(["running", "exited"]),
      pid: z.number(),
    })
    .meta({ ref: "Pty" })

  export type Info = z.infer<typeof Info>

  export const CreateInput = z.object({
    sessionID: Identifier.schema("session").optional(),
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
        rows: z.number().int().min(1).max(65535),
        cols: z.number().int().min(1).max(65535),
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
    process: Awaited<ReturnType<typeof spawn>>
    ended?: Promise<void>
    buffer: string
    subscribers: Set<Client>
    outputBytes: number
    outputTimer?: ReturnType<typeof setTimeout>
  }

  function container() {
    return {
      sessions: new Map<string, ActiveSession>(),
      pending: new Set<{ abort: AbortController; done: Promise<void> }>(),
      closing: false,
    }
  }
  async function dispose(state: ReturnType<typeof container>) {
    state.closing = true
    for (const launch of state.pending) launch.abort.abort(new DOMException("Terminal owner disposed", "AbortError"))
    await Promise.allSettled([...state.pending].map((launch) => launch.done))
    const results = await Promise.allSettled(
      [...state.sessions.values()].map(async (session) => {
        await session.process.stop()
        await session.ended
      }),
    )
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, "PTY processes could not be stopped")
  }
  const state = ScopedState.create(container, dispose)
  const owners = WorkspaceState.create(container, dispose)

  export function list() {
    return Array.from(state().sessions.values()).map((s) => s.info)
  }

  export function get(id: string) {
    return state().sessions.get(id)?.info
  }

  export async function create(input: CreateInput, signal?: AbortSignal): Promise<Info> {
    if (!input.sessionID) return createInWorkspace(input, signal)
    const session = await Session.get(input.sessionID)
    const scope = ScopeContext.current.scope
    if (session.scope.id !== scope.id) throw new Storage.NotFoundError({ message: "Session not found in this Scope" })
    await Session.assertWorkspaceAvailable(session.id)
    return ScopeContext.provide({
      scope,
      workspace: session.workspace,
      fn: () =>
        WorkspaceAccess.task({ sessionID: session.id, workspace: session.workspace, signal }, () =>
          createInWorkspace(input, signal),
        ),
    })
  }

  async function createInWorkspace(input: CreateInput, signal?: AbortSignal): Promise<Info> {
    const workspace = ScopeContext.current.workspace
    if (!workspace?.id || workspace.generation === undefined)
      throw new Scope.WorkspaceRequiredError({
        message: "A resolved Workspace is required for a terminal",
        scopeID: ScopeContext.current.scope.id,
      })
    const workspaceDirectory = workspace.path
    const id = Identifier.create("pty", false)
    const command = input.command || Shell.preferred()
    const args = [...(input.args ?? [])]
    if (command.endsWith("sh")) {
      args.push("-l")
    }

    const cwd = input.cwd || workspaceDirectory
    const env = Object.fromEntries(
      Object.entries({ ...RuntimeContext.current().host.env, ...input.env, TERM: "xterm-256color" }).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    )
    log.info("creating session", { id, cmd: command, args, cwd })

    const scopeOwner = state()
    const workspaceOwner = owners()
    if (scopeOwner.closing || workspaceOwner.closing) throw new Error("Terminal owner is closing")
    const scopeSessions = scopeOwner.sessions
    const workspaceSessions = workspaceOwner.sessions
    const abort = new AbortController()
    const finished = Promise.withResolvers<void>()
    const launch = { abort, done: finished.promise }
    scopeOwner.pending.add(launch)
    workspaceOwner.pending.add(launch)
    const cancelled = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
    let started: Awaited<ReturnType<typeof spawn>> | undefined
    try {
      const ptyProcess = await spawn({ command, args, cwd, env }, cancelled)
      started = ptyProcess
      cancelled.throwIfAborted()

      const startTime = Date.now()
      const info = {
        id,
        sessionID: input.sessionID,
        title: input.title || `Terminal ${id.slice(-4)}`,
        command,
        args,
        cwd,
        workspaceID: workspace.id,
        workspaceGeneration: workspace.generation,
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
      ObservabilityMetrics.record({
        name: "pty.session.created",
        value: 1,
        unit: "count",
        module: "pty",
        source: "process",
        processId: id,
        pid: ptyProcess.pid,
        labels: {
          cwdScope: ObservabilityRedaction.cwdScope(cwd),
          command: ObservabilityRedaction.commandFamily(command),
        },
      })
      scopeSessions.set(id, session)
      workspaceSessions.set(id, session)
      ptyProcess.output.setEncoding("utf8")
      ptyProcess.output.on(
        "data",
        AsyncLocalStorage.bind((data: string) => {
          session.outputBytes += Buffer.byteLength(data)
          if (!session.outputTimer) {
            session.outputTimer = setTimeout(() => {
              const value = session.outputBytes
              session.outputBytes = 0
              session.outputTimer = undefined
              ObservabilityMetrics.record({
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
            try {
              send(ws, data)
              open = true
            } catch {
              session.subscribers.delete(ws)
              ws.close()
              ObservabilityMetrics.record({
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
          session.buffer = tail(session.buffer)
        }),
      )
      const flushOutputBytes = () => {
        if (session.outputTimer) clearTimeout(session.outputTimer)
        session.outputTimer = undefined
        if (!session.outputBytes) return
        const value = session.outputBytes
        session.outputBytes = 0
        ObservabilityMetrics.record({
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
      const drained = ptyProcess.output.readableEnded ? Promise.resolve() : once(ptyProcess.output, "end")
      void drained.catch(() => {})
      session.ended = ptyProcess.completed
        .then(
          AsyncLocalStorage.bind(async (exitCode) => {
            await drained
            session.info.status = "exited"
            flushOutputBytes()
            for (const ws of session.subscribers) ws.close()
            session.subscribers.clear()
            await Bus.publish(Event.Exited, { id, exitCode })
            ObservabilityMetrics.record({
              name: "pty.session.duration",
              value: Date.now() - startTime,
              unit: "ms",
              module: "pty",
              source: "process",
              processId: id,
              pid: ptyProcess.pid,
              labels: { exitCode },
            })
          }),
        )
        .finally(() => {
          clearTimeout(session.outputTimer)
          for (const ws of session.subscribers) ws.close()
          session.subscribers.clear()
          scopeSessions.delete(id)
          workspaceSessions.delete(id)
        })
      void session.ended.catch((error) => log.error("PTY completion failed", { id, error }))
      Bus.publish(Event.Created, { info })
      return info
    } catch (error) {
      await started?.stop()
      scopeSessions.delete(id)
      workspaceSessions.delete(id)
      throw error
    } finally {
      scopeOwner.pending.delete(launch)
      workspaceOwner.pending.delete(launch)
      finished.resolve()
    }
  }

  export async function update(id: string, input: UpdateInput) {
    const session = state().sessions.get(id)
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

  export async function removeForSession(sessionID: string) {
    const sessions = state.peek()?.sessions
    if (!sessions) return
    for (const session of sessions.values()) {
      if (session.info.sessionID === sessionID) await remove(session.info.id)
    }
  }

  export async function remove(id: string) {
    const session = state().sessions.get(id)
    if (!session) return
    log.info("removing session", { id })
    await session.process.stop()
    await session.ended
    Bus.publish(Event.Deleted, { id })
  }

  export function resize(id: string, cols: number, rows: number) {
    const session = state().sessions.get(id)
    if (session && session.info.status === "running") {
      session.process.resize(cols, rows)
    }
  }

  export function write(id: string, data: string) {
    const session = state().sessions.get(id)
    if (session && session.info.status === "running") {
      ObservabilityMetrics.record({
        name: "pty.input.bytes",
        value: Buffer.byteLength(data),
        unit: "bytes",
        module: "pty",
        source: "process",
        processId: id,
        pid: session.info.pid,
      })
      writeInput(session, data)
    }
  }

  function writeInput(session: ActiveSession, data: string | Buffer) {
    const bytes = Buffer.byteLength(data)
    if (bytes + session.process.input.writableLength > 256 * 1024) throw new Error("PTY input buffer is full")
    session.process.input.write(data)
  }

  function send(ws: Client, data: string) {
    if ((ws.bufferedAmount ?? 0) + Buffer.byteLength(data) > 4 * 1024 * 1024) throw new Error("PTY client is too slow")
    ws.send(data)
  }

  function tail(value: string) {
    const result = value.slice(-BUFFER_LIMIT)
    const first = result.charCodeAt(0)
    return first >= 0xdc00 && first <= 0xdfff ? result.slice(1) : result
  }

  export function connect(id: string, ws: Client) {
    const session = state().sessions.get(id)
    if (!session) {
      ws.close()
      return
    }
    log.info("client connected to session", { id })
    if (session.subscribers.size >= 32) {
      ws.close()
      return
    }
    session.subscribers.add(ws)
    const connectedAt = Date.now()
    ObservabilityMetrics.record({
      name: "pty.websocket.connection.open",
      value: 1,
      unit: "count",
      module: "pty",
      source: "process",
      processId: id,
      pid: session.info.pid,
    })
    if (session.buffer) {
      const buffer = tail(session.buffer)
      session.buffer = ""
      try {
        for (let offset = 0; offset < buffer.length; ) {
          let end = Math.min(buffer.length, offset + BUFFER_CHUNK)
          if (end < buffer.length && buffer.charCodeAt(end - 1) >= 0xd800 && buffer.charCodeAt(end - 1) <= 0xdbff) end--
          send(ws, buffer.slice(offset, end))
          offset = end
        }
      } catch {
        session.subscribers.delete(ws)
        session.buffer = buffer
        ws.close()
        ObservabilityMetrics.record({
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
      onMessage: (message: string | ArrayBufferLike) => {
        ObservabilityMetrics.record({
          name: "pty.input.bytes",
          value: typeof message === "string" ? Buffer.byteLength(message) : message.byteLength,
          unit: "bytes",
          module: "pty",
          source: "process",
          processId: id,
          pid: session.info.pid,
          labels: { via: "websocket" },
        })
        try {
          writeInput(session, typeof message === "string" ? message : Buffer.from(message))
        } catch {
          session.subscribers.delete(ws)
          ws.close()
        }
      },
      onClose: () => {
        log.info("client disconnected from session", { id })
        session.subscribers.delete(ws)
        ObservabilityMetrics.record({
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
