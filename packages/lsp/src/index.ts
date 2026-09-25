import { WorkspaceEvents } from "@ericsanchezok/synergy-harness/workspace/events"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { withTimeout } from "@ericsanchezok/synergy-harness/util/timeout"
import { BusEvent } from "@ericsanchezok/synergy-harness/bus/bus-event"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { LSPClient } from "./client"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { LSPServer } from "./server"
import { z } from "zod"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { LSPProcess } from "./process"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceState } from "@ericsanchezok/synergy-harness/workspace/state"
import { LSPPid } from "./pid"
import { LSPSchema } from "./schema"

export namespace LSP {
  const log = Log.create({ service: "lsp" })

  export const Event = {
    Updated: BusEvent.define("lsp.updated", z.object(WorkspaceEvents.Fields)),
  }

  export const Range = LSPSchema.Range
  export type Range = LSPSchema.Range

  export const Symbol = z
    .object({
      name: z.string(),
      kind: z.number(),
      location: z.object({
        uri: z.string(),
        range: Range,
      }),
    })
    .meta({
      ref: "Symbol",
    })
  export type Symbol = z.infer<typeof Symbol>

  export const DocumentSymbol = z
    .object({
      name: z.string(),
      detail: z.string().optional(),
      kind: z.number(),
      range: Range,
      selectionRange: Range,
    })
    .meta({
      ref: "DocumentSymbol",
    })
  export type DocumentSymbol = z.infer<typeof DocumentSymbol>

  type Running = Awaited<ReturnType<typeof LSPProcess.start>>
  interface Connection {
    server: LSPServer.Info
    root: string
    diagnostics: Map<string, LSPClient.Diagnostic[]>
    files: Set<string>
    live?: Managed
    spawning?: Promise<Managed | undefined>
  }
  interface Managed {
    client: LSPClient.Info
    process: Running
    record: Connection
    active: number
    idle: ReturnType<typeof Promise.withResolvers<void>>
    lastUsed: number
    idleMs: number
    retiring?: Promise<void>
    retire(): Promise<void>
  }
  const LSP_IDLE_MS = 30 * 60 * 1000
  const LSP_WORKTREE_IDLE_MS = 5 * 60 * 1000
  const LSP_QUERY_MS = 30000
  const runtimeState = RuntimeContext.state(() => ({
    clients: new Set<Managed>(),
    timer: undefined as ReturnType<typeof setInterval> | undefined,
    polling: undefined as Promise<void> | undefined,
  }))
  function monitor(entry: Managed) {
    const runtime = RuntimeContext.current()
    const state = runtimeState()
    state.clients.add(entry)
    if (state.timer) return
    state.timer = setInterval(() => {
      if (state.polling) return
      state.polling = RuntimeContext.exit(() =>
        runtime.run(async () => {
          const waiting = new Set(await WorkspaceAccess.contendedProcesses())
          await Promise.all(
            [...state.clients].map(async (client) => {
              if (client.active || client.retiring) return
              if (!waiting.has(client.process.claimID) && Date.now() - client.lastUsed < client.idleMs) return
              await client.retire()
            }),
          )
        }),
      )
        .catch((error) => log.warn("LSP retirement failed", { error }))
        .finally(() => {
          state.polling = undefined
          if (state.clients.size) return
          clearInterval(state.timer)
          state.timer = undefined
        })
    }, 100)
    state.timer.unref()
  }
  const state = WorkspaceState.create(
    async () => {
      const cfg = await Config.current()
      const servers: Record<string, LSPServer.Info> = {}
      await LSPPid.cleanupOrphans()
      if (cfg.lsp !== false) {
        for (const server of Object.values(LSPServer)) servers[server.id] = server
        if (cfg.lsp?.ty?.disabled !== false) delete servers.ty
        for (const [name, item] of Object.entries(cfg.lsp ?? {})) {
          const existing = servers[name] ?? Object.values(LSPServer).find((server) => server.id === name)
          if (item.disabled) {
            delete servers[name]
            continue
          }
          if (!item.command) {
            if (!existing) throw new Error(`LSP server ${name} requires a command`)
            if (item.env) throw new Error(`LSP server ${name} requires an explicit command to override its environment`)
            servers[name] = {
              ...existing,
              extensions: item.extensions ?? existing.extensions,
              async resolve(root) {
                const resolved = await existing.resolve(root)
                if (!resolved) return
                return { ...resolved, initialization: { ...resolved.initialization, ...item.initialization } }
              },
            }
            continue
          }
          const command = item.command
          servers[name] = {
            ...existing,
            id: name,
            root: existing?.root ?? (async () => ScopeContext.current.directory),
            extensions: item.extensions ?? existing?.extensions ?? [],
            async resolve(root) {
              return {
                command: { command: command[0]!, args: command.slice(1), cwd: root, env: item.env },
                initialization: item.initialization,
              }
            },
          }
        }
      }
      return {
        servers,
        connections: new Map<string, Connection>(),
        broken: new Set<string>(),
        controller: new AbortController(),
        pending: new Set<Promise<unknown>>(),
        idleReap: cfg.execution?.lspIdleReap !== false,
      }
    },
    async (state) => {
      state.controller.abort(new DOMException("Language server resources disposed", "AbortError"))
      await Promise.allSettled([...state.pending])
      await Promise.all([...state.connections.values()].map((record) => record.live?.retire()))
      const registry = runtimeState()
      if (!registry.clients.size) {
        clearInterval(registry.timer)
        registry.timer = undefined
        await registry.polling
      }
    },
  )

  export async function reload() {
    log.info("reloading lsp state")
    await state.resetAll()
    log.info("lsp state reloaded")
  }

  export async function init() {
    return state()
  }

  export const Status = z
    .object({
      id: z.string(),
      name: z.string(),
      root: z.string(),
      status: z.union([z.literal("connected"), z.literal("error")]),
    })
    .meta({
      ref: "LSPStatus",
    })
  export type Status = z.infer<typeof Status>

  export async function connectionCount() {
    const s = await state()
    return [...s.connections.keys()].filter((key) => !s.broken.has(key)).length
  }

  export async function status() {
    const s = await state()
    return [...s.connections.values()].flatMap((record): Status[] =>
      record.live && !record.live.retiring
        ? [
            {
              id: record.server.id,
              name: record.server.id,
              root: path.relative(ScopeContext.current.directory, record.root),
              status: "connected",
            },
          ]
        : [],
    )
  }

  async function schedule(s: Awaited<ReturnType<typeof state>>, record: Connection, key: string) {
    const scope = ScopeContext.current.scope
    const workspace = ScopeContext.current.workspace
    const publish = () =>
      ScopeContext.provide({ scope, workspace, fn: () => WorkspaceEvents.publish(Event.Updated, {}) })
    const deadline = new AbortController()
    const timer = setTimeout(
      () => deadline.abort(new DOMException("Language server startup timed out", "TimeoutError")),
      LSP_QUERY_MS,
    )
    const task = WorkspaceAccess.signal()
    const signal = AbortSignal.any([s.controller.signal, deadline.signal, ...(task ? [task] : [])])
    let process: Running | undefined
    let client: LSPClient.Info | undefined
    let cleanup: (() => Promise<void>) | undefined
    const stop = () => {
      void process?.stop().catch(() => {})
    }
    signal.addEventListener("abort", stop, { once: true })
    try {
      const prepared = await LSPProcess.resolving(signal, () => record.server.resolve(record.root))
      cleanup = prepared.dispose
      const launch = prepared.value
      signal.throwIfAborted()
      if (!launch) {
        s.broken.add(key)
        return
      }
      process = await LSPProcess.start(launch.command, signal, true, cleanup)
      process.child.stderr.resume()
      signal.throwIfAborted()
      await process.activate()
      client = await LSPClient.create({
        serverID: record.server.id,
        server: { process: process.child, initialization: launch.initialization },
        root: record.root,
        signal,
      })
      signal.throwIfAborted()
      for (const file of record.files)
        await client.notify
          .open({ path: file })
          .catch((error) => log.info("LSP document could not be reopened", { error }))
      const owned = process
      const connected = client
      const registry = runtimeState()
      const entry: Managed = {
        process: owned,
        client: connected,
        record,
        active: 0,
        idle: Promise.withResolvers<void>(),
        lastUsed: Date.now(),
        idleMs: !s.idleReap
          ? Infinity
          : ScopeContext.current.workspace?.type === "git_worktree"
            ? LSP_WORKTREE_IDLE_MS
            : LSP_IDLE_MS,
        retire() {
          return (entry.retiring ??= (async () => {
            if (entry.active) await entry.idle.promise
            try {
              await connected.shutdown()
            } finally {
              await owned.stop()
              await remove()
            }
          })())
        },
      }
      record.live = entry
      record.diagnostics = connected.diagnostics
      const remove = async () => {
        registry.clients.delete(entry)
        if (record.live !== entry) return
        record.live = undefined
        await publish()
      }
      const dispose = () => {
        void entry.retire().catch((error) => log.warn("LSP disposal failed", { error }))
      }
      s.controller.signal.addEventListener("abort", dispose, { once: true })
      void owned.completion
        .catch((error) => log.warn("LSP process failed", { error }))
        .finally(async () => {
          s.controller.signal.removeEventListener("abort", dispose)
          await remove()
          s.broken.delete(key)
        })
        .catch((error) => log.warn("LSP exit notification failed", { error }))
      monitor(entry)
      await publish()
      return entry
    } catch (error) {
      if (client) await client.shutdown()
      else if (process) {
        process.child.stdout.resume()
        await process.stop()
      }
      if (!signal.aborted) s.broken.add(key)
      log.error(`Failed to start LSP server ${record.server.id}`, { error })
      signal.throwIfAborted()
    } finally {
      clearTimeout(timer)
      signal.removeEventListener("abort", stop)
      if (!process) await cleanup?.()
    }
  }

  async function use<T>(
    s: Awaited<ReturnType<typeof state>>,
    record: Connection,
    input: (client: LSPClient.Info) => Promise<T>,
  ): Promise<T | undefined> {
    const key = JSON.stringify([record.root, record.server.id])
    while (true) {
      s.controller.signal.throwIfAborted()
      WorkspaceAccess.signal()?.throwIfAborted()
      let entry = record.live
      if (entry?.retiring) {
        await entry.retiring
        continue
      }
      if (entry && !entry.active && (await WorkspaceAccess.contendedProcesses()).includes(entry.process.claimID)) {
        await entry.retire()
        continue
      }
      if (!entry) {
        if (s.broken.has(key)) return
        let launching = false
        if (!record.spawning) {
          launching = true
          const task = schedule(s, record, key)
          record.spawning = task
          s.pending.add(task)
          void task
            .finally(() => {
              s.pending.delete(task)
              if (record.spawning === task) record.spawning = undefined
            })
            .catch(() => {})
        }
        try {
          entry = await record.spawning
        } catch (error) {
          s.controller.signal.throwIfAborted()
          WorkspaceAccess.signal()?.throwIfAborted()
          if (!launching && error instanceof Error && error.name === "AbortError") continue
          throw error
        }
        if (!entry) return
      }
      if (entry.retiring || record.live !== entry) continue
      if (!entry.active) entry.idle = Promise.withResolvers<void>()
      entry.active++
      entry.lastUsed = Date.now()
      const taskSignal = WorkspaceAccess.signal()
      const signal = AbortSignal.any([s.controller.signal, ...(taskSignal ? [taskSignal] : [])])
      const cancelled = Promise.withResolvers<never>()
      void cancelled.promise.catch(() => {})
      const abort = () => cancelled.reject(signal.reason)
      signal.addEventListener("abort", abort, { once: true })
      try {
        signal.throwIfAborted()
        return await withTimeout(Promise.race([input(entry.client), cancelled.promise]), LSP_QUERY_MS)
      } catch (error) {
        void entry.retire().catch((error) => log.warn("LSP query retirement failed", { error }))
        throw error
      } finally {
        signal.removeEventListener("abort", abort)
        entry.active--
        if (!entry.active) entry.idle.resolve()
        entry.lastUsed = Date.now()
        if (entry.retiring) await entry.retiring
      }
    }
  }

  async function records(file: string) {
    const s = await state()
    const extension = path.parse(file).ext || file
    const result: Connection[] = []
    for (const server of Object.values(s.servers)) {
      if (server.extensions.length && !server.extensions.includes(extension)) continue
      const root = await server.root(file)
      if (!root) continue
      const key = JSON.stringify([root, server.id])
      if (s.broken.has(key)) continue
      let record = s.connections.get(key)
      if (!record) {
        record = { server, root, diagnostics: new Map(), files: new Set() }
        s.connections.set(key, record)
      }
      result.push(record)
    }
    return { s, records: result }
  }

  export async function hasClients(file: string) {
    const s = await state()
    const extension = path.parse(file).ext || file
    for (const server of Object.values(s.servers)) {
      if (server.extensions.length && !server.extensions.includes(extension)) continue
      const root = await server.root(file)
      if (!root) continue
      if (s.broken.has(JSON.stringify([root, server.id]))) continue
      return true
    }
    return false
  }

  export async function touchFile(file: string, waitForDiagnostics?: boolean) {
    await WorkspaceAccess.withinTask(async () => {
      const selected = await records(file)
      for (const record of selected.records) {
        await use(selected.s, record, async (client) => {
          const wait = waitForDiagnostics ? client.waitForDiagnostics({ path: file }) : Promise.resolve()
          await client.notify.open({ path: file })
          record.files.add(file)
          await wait
        })
      }
    }).catch((error) => {
      log.error("failed to touch file", { error, file })
    })
  }

  export async function diagnostics() {
    const results: Record<string, LSPClient.Diagnostic[]> = {}
    for (const record of (await state()).connections.values()) {
      for (const [file, diagnostics] of record.diagnostics) (results[file] ??= []).push(...diagnostics)
    }
    return results
  }

  export async function hover(input: { file: string; line: number; character: number }) {
    return run(input.file, (client) => {
      return client.connection
        .sendRequest("textDocument/hover", {
          textDocument: {
            uri: pathToFileURL(input.file).href,
          },
          position: {
            line: input.line,
            character: input.character,
          },
        })
        .catch(() => null)
    })
  }

  enum SymbolKind {
    File = 1,
    Module = 2,
    Namespace = 3,
    Package = 4,
    Class = 5,
    Method = 6,
    Property = 7,
    Field = 8,
    Constructor = 9,
    Enum = 10,
    Interface = 11,
    Function = 12,
    Variable = 13,
    Constant = 14,
    String = 15,
    Number = 16,
    Boolean = 17,
    Array = 18,
    Object = 19,
    Key = 20,
    Null = 21,
    EnumMember = 22,
    Struct = 23,
    Event = 24,
    Operator = 25,
    TypeParameter = 26,
  }

  const kinds = [
    SymbolKind.Class,
    SymbolKind.Function,
    SymbolKind.Method,
    SymbolKind.Interface,
    SymbolKind.Variable,
    SymbolKind.Constant,
    SymbolKind.Struct,
    SymbolKind.Enum,
  ]

  export async function workspaceSymbol(query: string, signal?: AbortSignal) {
    return runAll(
      (client) =>
        client.connection
          .sendRequest("workspace/symbol", {
            query,
          })
          .then((result: any) => result.filter((x: LSP.Symbol) => kinds.includes(x.kind)))
          .then((result: any) => result.slice(0, 10))
          .catch(() => []),
      signal,
    ).then((result) => result.flat() as LSP.Symbol[])
  }

  export async function documentSymbol(uri: string) {
    const file = fileURLToPath(uri)
    return run(file, (client) =>
      client.connection
        .sendRequest("textDocument/documentSymbol", {
          textDocument: {
            uri,
          },
        })
        .catch(() => []),
    )
      .then((result) => result.flat() as (LSP.DocumentSymbol | LSP.Symbol)[])
      .then((result) => result.filter(Boolean))
  }

  export async function definition(input: { file: string; line: number; character: number }) {
    return run(input.file, (client) =>
      client.connection
        .sendRequest("textDocument/definition", {
          textDocument: { uri: pathToFileURL(input.file).href },
          position: { line: input.line, character: input.character },
        })
        .catch(() => null),
    ).then((result) => result.flat().filter(Boolean))
  }

  export async function references(input: { file: string; line: number; character: number }) {
    return run(input.file, (client) =>
      client.connection
        .sendRequest("textDocument/references", {
          textDocument: { uri: pathToFileURL(input.file).href },
          position: { line: input.line, character: input.character },
          context: { includeDeclaration: true },
        })
        .catch(() => []),
    ).then((result) => result.flat().filter(Boolean))
  }

  export async function implementation(input: { file: string; line: number; character: number }) {
    return run(input.file, (client) =>
      client.connection
        .sendRequest("textDocument/implementation", {
          textDocument: { uri: pathToFileURL(input.file).href },
          position: { line: input.line, character: input.character },
        })
        .catch(() => null),
    ).then((result) => result.flat().filter(Boolean))
  }

  export async function prepareCallHierarchy(input: { file: string; line: number; character: number }) {
    return run(input.file, (client) =>
      client.connection
        .sendRequest("textDocument/prepareCallHierarchy", {
          textDocument: { uri: pathToFileURL(input.file).href },
          position: { line: input.line, character: input.character },
        })
        .catch(() => []),
    ).then((result) => result.flat().filter(Boolean))
  }

  export async function incomingCalls(input: { file: string; line: number; character: number }) {
    return run(input.file, async (client) => {
      const items = (await client.connection
        .sendRequest("textDocument/prepareCallHierarchy", {
          textDocument: { uri: pathToFileURL(input.file).href },
          position: { line: input.line, character: input.character },
        })
        .catch(() => [])) as any[]
      if (!items?.length) return []
      return client.connection.sendRequest("callHierarchy/incomingCalls", { item: items[0] }).catch(() => [])
    }).then((result) => result.flat().filter(Boolean))
  }

  export async function outgoingCalls(input: { file: string; line: number; character: number }) {
    return run(input.file, async (client) => {
      const items = (await client.connection
        .sendRequest("textDocument/prepareCallHierarchy", {
          textDocument: { uri: pathToFileURL(input.file).href },
          position: { line: input.line, character: input.character },
        })
        .catch(() => [])) as any[]
      if (!items?.length) return []
      return client.connection.sendRequest("callHierarchy/outgoingCalls", { item: items[0] }).catch(() => [])
    }).then((result) => result.flat().filter(Boolean))
  }

  async function runAll<T>(input: (client: LSPClient.Info) => Promise<T>, signal?: AbortSignal): Promise<T[]> {
    return WorkspaceAccess.withinTask(async () => {
      const s = await state()
      const result: T[] = []
      for (const record of [...s.connections.values()]) {
        const value = await use(s, record, input)
        if (value !== undefined) result.push(value)
      }
      return result
    }, signal)
  }

  async function run<T>(file: string, input: (client: LSPClient.Info) => Promise<T>): Promise<T[]> {
    return WorkspaceAccess.withinTask(async () => {
      const selected = await records(file)
      const result: T[] = []
      for (const record of selected.records) {
        const value = await use(selected.s, record, input)
        if (value !== undefined) result.push(value)
      }
      return result
    })
  }

  export namespace Diagnostic {
    export function pretty(diagnostic: LSPClient.Diagnostic) {
      const severityMap = {
        1: "ERROR",
        2: "WARN",
        3: "INFO",
        4: "HINT",
      }

      const severity = severityMap[diagnostic.severity || 1]
      const line = diagnostic.range.start.line + 1
      const col = diagnostic.range.start.character + 1

      return `${severity} [${line}:${col}] ${diagnostic.message}`
    }
  }
}
