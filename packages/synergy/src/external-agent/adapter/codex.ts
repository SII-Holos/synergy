import { Log } from "@/util/log"
import { ExternalAgent } from "../bridge"

const log = Log.create({ service: "external-agent.codex" })

const CLIENT_INFO = {
  name: "synergy",
  title: "Synergy",
  version: "1.0.0",
}

type QueueEntry = { event: ExternalAgent.BridgeEvent } | { done: true }

interface PendingRequest {
  resolve: (result: any) => void
  reject: (error: Error) => void
}

class CodexAdapter implements ExternalAgent.Adapter {
  readonly name = "codex"

  readonly capabilities: ExternalAgent.Capabilities = {
    modelSwitch: false,
    interrupt: true,
  }

  get started(): boolean {
    return this.alive
  }

  private proc: import("bun").Subprocess<"pipe", "pipe", "pipe"> | undefined
  private requestId = 0
  private threads = new Map<string, string>()
  private activeSessionID = ""
  private turnId = ""
  private cwd = ""
  private adapterConfig: Record<string, unknown> = {}
  private pending = new Map<number, PendingRequest>()
  private pendingApprovals = new Map<number, string>()
  private queue: QueueEntry[] = []
  private queueResolve: (() => void) | undefined
  private alive = false
  private lastUsage: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } | undefined
  private streamedAgentMessages = new Set<string>()

  async discover(): Promise<{ available: boolean; path?: string; version?: string }> {
    const binPath = Bun.which("codex")
    if (!binPath) return { available: false }

    try {
      const proc = Bun.spawn(["codex", "--version"], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const text = await new Response(proc.stdout).text()
      await proc.exited
      const version = text.trim().split("\n")[0] || undefined
      return { available: true, path: binPath, version }
    } catch (e) {
      log.warn("version check failed", { error: String(e) })
      return { available: true, path: binPath }
    }
  }

  async start(opts: ExternalAgent.StartOptions): Promise<void> {
    if (this.proc) await this.shutdown()

    this.cwd = opts.cwd
    this.adapterConfig = opts.config ?? {}

    const args = ["codex", "app-server"]
    const env: Record<string, string | undefined> = opts.env ? { ...process.env, ...opts.env } : { ...process.env }

    const model = this.adapterConfig.model as string | undefined
    const providerID = this.adapterConfig.providerID as string | undefined
    const baseURL = this.adapterConfig.baseURL as string | undefined
    const apiKey = env["SYNERGY_CODEX_API_KEY"]

    if (model || baseURL) {
      const alias = providerID ?? "synergy"
      if (model) args.push("-c", `model="${model}"`)
      if (baseURL) {
        args.push("-c", `model_provider="${alias}"`)
        args.push("-c", `model_providers.${alias}.base_url="${baseURL}"`)
        if (apiKey) {
          args.push("-c", `model_providers.${alias}.env_key="SYNERGY_CODEX_API_KEY"`)
        }
      }
    }

    this.proc = Bun.spawn(args, {
      cwd: opts.cwd,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    this.alive = true

    log.info("spawned codex app-server", { pid: this.proc.pid, cwd: opts.cwd, overrideArgs: args.slice(2) })

    this.readStdout()
    this.readStderr()
    this.watchExit()

    await this.initialize()
  }

  async *turn(context: ExternalAgent.TurnContext, signal?: AbortSignal): AsyncGenerator<ExternalAgent.BridgeEvent> {
    if (!this.proc || !this.alive) throw new Error("codex process not running")

    this.queue = []
    this.queueResolve = undefined
    this.lastUsage = undefined
    this.streamedAgentMessages.clear()

    const onAbort = () => {
      log.warn("turn aborted via signal")
      this.interrupt().catch(() => {})
      this.drainQueue()
    }
    signal?.addEventListener("abort", onAbort, { once: true })

    try {
      const threadId = await this.ensureThread(context.sessionID)
      this.activeSessionID = context.sessionID
      const input = composeTurnInput(context)
      log.info("sending turn/start", { sessionID: context.sessionID, threadId, inputLength: input.length })
      const turnResult = (await this.sendRequest("turn/start", {
        threadId,
        input: [{ type: "text", text: input }],
      })) as any
      this.turnId = turnResult?.turn?.id ?? turnResult?.id ?? ""
      const turnStatus = turnResult?.turn?.status ?? turnResult?.status ?? "unknown"
      log.info("turn/start resolved", { turnId: this.turnId, status: turnStatus })

      while (true) {
        if (signal?.aborted) return

        while (this.queue.length === 0) {
          await new Promise<void>((r) => {
            this.queueResolve = r
          })
        }

        while (this.queue.length > 0) {
          const entry = this.queue.shift()!
          if ("done" in entry) return
          yield entry.event
          if (entry.event.type === "turn_complete" || entry.event.type === "error") return
        }
      }
    } finally {
      signal?.removeEventListener("abort", onAbort)
    }
  }

  async respondApproval(requestID: string, approved: boolean): Promise<void> {
    const numericId = Number(requestID)
    if (isNaN(numericId)) return
    const entry = this.pendingApprovals.get(numericId)
    this.pendingApprovals.delete(numericId)

    let result: Record<string, unknown>
    if (entry === "permissions") {
      result = approved ? { permissions: {}, scope: "session" } : { permissions: {}, scope: "turn" }
    } else {
      result = { decision: approved ? "accept" : "decline" }
    }
    log.info("respondApproval", { requestID, numericId, approved, category: entry, result })
    this.sendResponse(numericId, result)
  }

  async interrupt(): Promise<void> {
    const threadId = this.threads.get(this.activeSessionID)
    if (!threadId || !this.alive) return
    log.info("interrupt called", { sessionID: this.activeSessionID, threadId, turnId: this.turnId })
    try {
      await this.sendRequest("turn/interrupt", {
        threadId,
        turnId: this.turnId,
      })
    } catch (e) {
      log.debug("interrupt failed", { error: String(e) })
    }
  }

  async shutdown(): Promise<void> {
    if (!this.proc) return
    const proc = this.proc
    this.proc = undefined
    this.alive = false
    this.threads.clear()
    this.activeSessionID = ""
    this.turnId = ""
    this.drainQueue()
    this.pendingApprovals.clear()

    try {
      proc.kill("SIGTERM")
    } catch {}

    const exited = Promise.race([proc.exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 3000))])

    if ((await exited) === "timeout") {
      try {
        proc.kill("SIGKILL")
      } catch {}
    }

    for (const [, p] of this.pending) {
      p.reject(new Error("codex process shut down"))
    }
    this.pending.clear()

    log.info("codex process shut down")
  }

  // ---------------------------------------------------------------------------
  // Thread lifecycle
  // ---------------------------------------------------------------------------

  private async ensureThread(sessionID: string): Promise<string> {
    const existing = this.threads.get(sessionID)
    if (existing) return existing

    const params: Record<string, unknown> = { cwd: this.cwd }
    const { model, approvalPolicy, providerID: _p, baseURL: _b, ...rest } = this.adapterConfig
    if (model) params.model = model
    if (approvalPolicy) params.approvalPolicy = approvalPolicy
    Object.assign(params, rest)

    const threadResult = (await this.sendRequest("thread/start", params)) as any
    const threadId = threadResult?.id ?? threadResult?.thread?.id ?? ""
    if (!threadId) {
      throw new Error("codex thread/start did not return a threadId")
    }
    this.threads.set(sessionID, threadId)
    log.info("thread started", { sessionID, threadId })
    return threadId
  }

  // ---------------------------------------------------------------------------
  // JSON-RPC transport
  // ---------------------------------------------------------------------------

  private async initialize(): Promise<void> {
    await this.sendRequest("initialize", { clientInfo: CLIENT_INFO })
    this.sendNotification("initialized", {})
    log.info("initialize handshake complete")
  }

  private sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++this.requestId
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params })
    this.writeStdin(msg)

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params })
    this.writeStdin(msg)
  }

  private sendResponse(id: number, result: Record<string, unknown>): void {
    const msg = JSON.stringify({ jsonrpc: "2.0", id, result })
    this.writeStdin(msg)
  }

  private writeStdin(line: string): void {
    if (!this.proc) return
    try {
      this.proc.stdin.write(line + "\n")
      log.debug("stdin write ok", { bytes: line.length + 1 })
    } catch (e) {
      log.warn("stdin write failed", { error: String(e) })
    }
  }

  // ---------------------------------------------------------------------------
  // stdout / stderr parsing
  // ---------------------------------------------------------------------------

  private readStdout(): void {
    if (!this.proc) return
    const { Readable } = require("node:stream")
    const nodeStream: import("node:stream").Readable = Readable.fromWeb(this.proc.stdout)
    let buffer = ""
    nodeStream.on("data", (chunk: Buffer) => {
      log.debug("stdout chunk", { bytes: chunk.length })
      buffer += chunk.toString()
      let newline: number
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        this.handleMessage(line)
      }
    })
    nodeStream.on("end", () => {
      log.warn("stdout stream ended", { alive: this.alive, pid: this.proc?.pid })
    })
    nodeStream.on("error", (e: Error) => {
      if (this.alive) {
        log.warn("stdout read error", { error: String(e) })
      }
    })
  }

  private readStderr(): void {
    if (!this.proc) return
    const { Readable } = require("node:stream")
    const nodeStream: import("node:stream").Readable = Readable.fromWeb(this.proc.stderr)
    let buffer = ""
    nodeStream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString()
      let newline: number
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        log.warn("codex stderr", { line: line.slice(0, 500) })
      }
    })
    nodeStream.on("error", () => {})
  }

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(raw)
    } catch {
      log.debug("non-json line from codex", { raw: raw.slice(0, 200) })
      return
    }

    const hasId = "id" in msg && msg.id != null
    const hasMethod = "method" in msg

    if (hasId && hasMethod) {
      log.info("server-request", { id: msg.id, method: msg.method })
      this.handleServerRequest(msg.id as number, msg.method as string, (msg.params ?? {}) as Record<string, unknown>)
      return
    }

    if (hasId && !hasMethod) {
      const id = msg.id as number
      const p = this.pending.get(id)
      if (p) {
        this.pending.delete(id)
        if (msg.error) {
          const errObj = msg.error as Record<string, unknown>
          log.warn("response error", { id, error: JSON.stringify(errObj).slice(0, 300) })
          p.reject(new Error(String(errObj.message ?? JSON.stringify(errObj))))
        } else {
          p.resolve(msg.result)
        }
      }
      return
    }

    if (hasMethod) {
      this.handleNotification(msg.method as string, (msg.params ?? {}) as Record<string, unknown>)
    }
  }

  // ---------------------------------------------------------------------------
  // Server-initiated requests (approvals)
  // ---------------------------------------------------------------------------

  private handleServerRequest(id: number, method: string, params: Record<string, unknown>): void {
    const event = this.mapServerRequest(id, method, params)
    if (event) {
      this.pushEvent(event)
    } else {
      this.sendResponse(id, {})
    }
  }

  private mapServerRequest(
    id: number,
    method: string,
    params: Record<string, unknown>,
  ): ExternalAgent.BridgeEvent | undefined {
    if (method === "item/commandExecution/requestApproval") {
      const command = (params.command as string) ?? "shell"
      this.pendingApprovals.set(id, "command")
      return {
        type: "approval_request",
        id: String(id),
        category: "command",
        tool: command,
        input: JSON.stringify({
          command,
          cwd: params.cwd,
          reason: params.reason,
        }),
      }
    }

    if (method === "item/fileChange/requestApproval") {
      this.pendingApprovals.set(id, "file_change")
      return {
        type: "approval_request",
        id: String(id),
        category: "file_change",
        tool: "file_edit",
        input: JSON.stringify({
          reason: params.reason,
        }),
      }
    }

    if (method === "item/permissions/requestApproval") {
      this.pendingApprovals.set(id, "permissions")
      return {
        type: "approval_request",
        id: String(id),
        category: "permissions",
        tool: "permissions",
        input: JSON.stringify({
          reason: params.reason,
          permissions: params.permissions,
        }),
      }
    }

    log.debug("unhandled server request", { id, method })
    this.sendResponse(id, {})
    return undefined
  }

  // ---------------------------------------------------------------------------
  // Notifications → BridgeEvents
  // ---------------------------------------------------------------------------

  private handleNotification(method: string, params: Record<string, unknown>): void {
    log.info("notification", { method })
    const events = this.mapNotification(method, params)
    for (const event of events) {
      this.pushEvent(event)
    }
  }

  private mapNotification(method: string, params: Record<string, unknown>): ExternalAgent.BridgeEvent[] {
    switch (method) {
      case "item/agentMessage/delta": {
        const itemId = (params.itemId ?? "") as string
        if (itemId) this.streamedAgentMessages.add(itemId)
        const raw = params.delta
        if (typeof raw === "string") {
          return [{ type: "text_delta", text: raw }]
        }
        const delta = (raw ?? params) as Record<string, string>
        const text = delta.content ?? delta.text ?? ""
        if (!text) {
          log.debug("agentMessage/delta with empty text", { params: JSON.stringify(params).slice(0, 300) })
        }
        return [{ type: "text_delta", text }]
      }

      case "item/started": {
        const item = (params.item ?? params) as Record<string, any>
        return this.mapItemStarted(item)
      }

      case "item/completed": {
        const item = (params.item ?? params) as Record<string, any>
        return this.mapItemCompleted(item)
      }

      case "item/commandExecution/outputDelta": {
        const itemId = (params.itemId ?? (params.item as any)?.id ?? "") as string
        const raw = (params.delta ?? "") as string
        let output: string
        try {
          output = atob(raw)
        } catch {
          output = raw
        }
        if (itemId && output) {
          return [{ type: "tool_output", id: itemId, output }]
        }
        return []
      }

      case "turn/completed": {
        const error = params.error as Record<string, unknown> | undefined
        if (error) {
          return [{ type: "error", message: String(error.message ?? JSON.stringify(error)) }]
        }
        const usage = this.lastUsage
        this.lastUsage = undefined
        return [{ type: "turn_complete", usage }]
      }

      case "thread/tokenUsage/updated": {
        const usage = (params.usage ?? params) as Record<string, number | undefined>
        this.lastUsage = {
          inputTokens: usage.inputTokens ?? usage.input_tokens,
          outputTokens: usage.outputTokens ?? usage.output_tokens,
          reasoningTokens: usage.reasoningTokens ?? usage.reasoning_tokens,
        }
        return []
      }

      case "turn/started":
      case "thread/started":
      case "thread/status/changed":
      case "account/rateLimits/updated":
        return []

      default:
        log.debug("unhandled codex notification", { method })
        return []
    }
  }

  // ---------------------------------------------------------------------------
  // Item event mapping
  // ---------------------------------------------------------------------------

  private mapItemStarted(item: Record<string, any>): ExternalAgent.BridgeEvent[] {
    const type = item.type as string
    const id = (item.id ?? "") as string

    switch (type) {
      case "commandExecution":
        return [
          {
            type: "tool_start",
            id,
            name: "shell",
            input: JSON.stringify({
              command: item.command,
              args: item.args,
              cwd: item.cwd,
            }),
          },
        ]

      case "fileEdit":
        return [
          {
            type: "tool_start",
            id,
            name: "file_edit",
            input: item.filePath ?? item.path,
          },
        ]

      case "reasoning":
        return [{ type: "reasoning_delta", text: "" }]

      case "agentMessage":
      case "userMessage":
        return []

      default:
        log.debug("unhandled item/started type", { type, id })
        return []
    }
  }

  private mapItemCompleted(item: Record<string, any>): ExternalAgent.BridgeEvent[] {
    const type = item.type as string
    const id = (item.id ?? "") as string

    switch (type) {
      case "commandExecution":
        return [
          {
            type: "tool_end",
            id,
            name: "shell",
            result: item.aggregatedOutput ?? item.output ?? "",
            error: item.exitCode !== 0 ? `exit code ${item.exitCode}` : undefined,
          },
        ]

      case "fileEdit":
        return [
          {
            type: "tool_end",
            id,
            name: "file_edit",
            result: item.filePath ?? item.path ?? "",
          },
        ]

      case "reasoning": {
        const text = extractItemText(item)
        if (text) return [{ type: "reasoning_delta", text }]
        return []
      }

      case "agentMessage": {
        if (this.streamedAgentMessages.has(id)) return []
        const text = extractItemText(item)
        if (text) return [{ type: "text_delta", text }]
        return []
      }

      case "userMessage":
        return []

      default:
        log.debug("unhandled item/completed type", { type, id })
        return []
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private pushEvent(event: ExternalAgent.BridgeEvent): void {
    this.queue.push({ event })
    this.queueResolve?.()
    this.queueResolve = undefined
  }

  private drainQueue(): void {
    log.info("drainQueue called")
    this.queue.push({ done: true })
    this.queueResolve?.()
    this.queueResolve = undefined
  }

  private async watchExit(): Promise<void> {
    if (!this.proc) return
    const code = await this.proc.exited

    if (this.alive) {
      this.alive = false
      log.warn("codex process exited unexpectedly", { code })
      this.pushEvent({
        type: "error",
        message: `codex process exited with code ${code}`,
      })
      this.drainQueue()

      for (const [, p] of this.pending) {
        p.reject(new Error("codex process exited"))
      }
      this.pending.clear()
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function composeTurnInput(context: ExternalAgent.TurnContext): string {
  const parts: string[] = []
  if (context.instructions) {
    parts.push(`<project-instructions>\n${context.instructions}\n</project-instructions>`)
  }
  if (context.taskContext) {
    parts.push(`<task-context>\n${context.taskContext}\n</task-context>`)
  }
  parts.push(context.prompt)
  return parts.join("\n\n")
}

function extractItemText(item: Record<string, any>): string {
  if (typeof item.text === "string") return item.text
  if (Array.isArray(item.content)) {
    return item.content
      .filter((c: any) => c.type === "text" || c.type === "output_text")
      .map((c: any) => c.text ?? "")
      .join("")
  }
  if (typeof item.content === "string") return item.content
  return ""
}

ExternalAgent.register("codex", () => new CodexAdapter())
