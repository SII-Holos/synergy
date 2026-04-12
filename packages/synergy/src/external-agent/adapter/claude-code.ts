import { Log } from "@/util/log"
import { ExternalAgent } from "../bridge"

const log = Log.create({ service: "external-agent.claude-code" })

type QueueEntry = { event: ExternalAgent.BridgeEvent } | { done: true }

/**
 * Claude Code adapter.
 *
 * Integration model: spawn `claude` per turn with `--print --output-format stream-json --verbose`.
 * Multi-turn is achieved via `--resume <session_id>`.
 * Model switching is supported without starting a new session — just pass `--model <model>`.
 * Permission control is handled via Claude Code CLI modes; Synergy currently maps session-level allowAll to a coarse permission mode.
 * No persistent process — each turn spawns a fresh subprocess.
 */
class ClaudeCodeAdapter implements ExternalAgent.Adapter {
  readonly name = "claude-code"

  readonly capabilities: ExternalAgent.Capabilities = {
    modelSwitch: true,
    interrupt: true,
  }

  get started(): boolean {
    return this._started
  }

  private _started = false
  private cwd = ""
  private adapterConfig: Record<string, unknown> = {}
  private sessions = new Map<string, string>()
  private currentProc: import("bun").Subprocess<"pipe", "pipe", "pipe"> | undefined
  private queue: QueueEntry[] = []
  private queueResolve: (() => void) | undefined
  private activeToolUses = new Map<string, { name: string }>()
  private env: Record<string, string | undefined> = {}

  async discover(): Promise<{ available: boolean; path?: string; version?: string }> {
    const binPath = Bun.which("claude")
    if (!binPath) return { available: false }

    try {
      const proc = Bun.spawn(["claude", "--version"], {
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
    this.cwd = opts.cwd
    this.adapterConfig = opts.config ?? {}
    this.env = opts.env ? { ...process.env, ...opts.env } : { ...process.env }
    this._started = true
    log.info("claude-code adapter started", { cwd: opts.cwd })
  }

  async *turn(context: ExternalAgent.TurnContext, signal?: AbortSignal): AsyncGenerator<ExternalAgent.BridgeEvent> {
    this.queue = []
    this.queueResolve = undefined
    this.activeToolUses.clear()
    this.activeSessionID = context.sessionID

    const args = this.buildArgs(context)
    log.info("spawning claude turn", { sessionID: context.sessionID, args: args.join(" ") })

    const proc = Bun.spawn(["claude", ...args], {
      cwd: this.cwd,
      env: this.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    this.currentProc = proc

    // Close stdin immediately — Claude Code in --print mode reads from args, not stdin
    try {
      proc.stdin.end()
    } catch {}

    const onAbort = () => {
      log.warn("turn aborted via signal")
      this.killCurrentProc()
      this.drainQueue()
    }
    signal?.addEventListener("abort", onAbort, { once: true })

    try {
      this.readStdout(proc)
      this.readStderr(proc)

      while (true) {
        if (signal?.aborted) return

        if (this.queue.length > 0) {
          const entry = this.queue.shift()!
          if ("done" in entry) return
          yield entry.event
          continue
        }

        await new Promise<void>((resolve) => {
          this.queueResolve = resolve
          // Also resolve when process exits
          proc.exited.then(() => resolve())
        })
      }
    } finally {
      signal?.removeEventListener("abort", onAbort)
      this.currentProc = undefined

      // Ensure process is cleaned up
      try {
        proc.kill("SIGTERM")
      } catch {}
    }
  }

  async interrupt(): Promise<void> {
    this.killCurrentProc()
    this.drainQueue()
  }

  async shutdown(): Promise<void> {
    this.killCurrentProc()
    this._started = false
    this.sessions.clear()
    log.info("claude-code adapter shut down")
  }

  // ---------------------------------------------------------------------------
  // Argument building
  // ---------------------------------------------------------------------------

  private buildArgs(context: ExternalAgent.TurnContext): string[] {
    const args = ["-p", "--output-format", "stream-json", "--verbose"]

    // Working directory
    args.push("-C", this.cwd)

    // Model override
    const model = this.adapterConfig.model as string | undefined
    if (model) args.push("--model", model)

    // Permission mode
    const permissionMode = this.adapterConfig.permissionMode as string | undefined
    const skipPermissions = this.adapterConfig.skipPermissions as boolean | undefined
    if (skipPermissions) {
      args.push("--dangerously-skip-permissions")
    } else if (permissionMode) {
      args.push("--permission-mode", permissionMode)
    }

    // Session resume for multi-turn
    const sessionId = this.sessions.get(context.sessionID)
    if (sessionId) {
      args.push("--resume", sessionId)
    }

    // System prompt injection
    if (context.instructions) {
      args.push("--append-system-prompt", context.instructions)
    }

    // Effort level
    const effort = this.adapterConfig.effort as string | undefined
    if (effort) args.push("--effort", effort)

    // Budget cap
    const maxBudget = this.adapterConfig.maxBudgetUsd as number | undefined
    if (maxBudget) args.push("--max-budget-usd", String(maxBudget))

    // The actual prompt text
    const prompt = context.taskContext ? `${context.taskContext}\n\n${context.prompt}` : context.prompt
    args.push(prompt)

    return args
  }

  // ---------------------------------------------------------------------------
  // stdout / stderr parsing (NDJSON stream-json)
  // ---------------------------------------------------------------------------

  private readStdout(proc: import("bun").Subprocess<"pipe", "pipe", "pipe">): void {
    const { Readable } = require("node:stream")
    const nodeStream: import("node:stream").Readable = Readable.fromWeb(proc.stdout)
    let buffer = ""

    nodeStream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString()
      let newline: number
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        this.handleLine(line)
      }
    })
    nodeStream.on("end", () => {
      // Process any remaining buffer
      if (buffer.trim()) {
        this.handleLine(buffer.trim())
      }
      log.info("stdout ended")
      this.drainQueue()
    })
    nodeStream.on("error", (e: Error) => {
      log.warn("stdout read error", { error: String(e) })
      this.drainQueue()
    })
  }

  private readStderr(proc: import("bun").Subprocess<"pipe", "pipe", "pipe">): void {
    const { Readable } = require("node:stream")
    const nodeStream: import("node:stream").Readable = Readable.fromWeb(proc.stderr)
    let buffer = ""

    nodeStream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString()
      let newline: number
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        log.debug("claude stderr", { line: line.slice(0, 500) })
      }
    })
    nodeStream.on("error", () => {})
  }

  private handleLine(raw: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(raw)
    } catch {
      log.debug("non-JSON line from claude", { raw: raw.slice(0, 200) })
      return
    }

    const type = msg.type as string
    switch (type) {
      case "system":
        this.handleSystemEvent(msg)
        break
      case "assistant":
        this.handleAssistantEvent(msg)
        break
      case "user":
        this.handleUserEvent(msg)
        break
      case "result":
        this.handleResultEvent(msg)
        break
      default:
        log.debug("unknown event type", { type })
    }
  }

  private handleSystemEvent(msg: Record<string, unknown>): void {
    const sessionId = msg.session_id as string | undefined
    if (sessionId) {
      log.info("system init", {
        sessionId,
        model: msg.model,
        version: msg.claude_code_version,
      })
    }
  }

  private handleAssistantEvent(msg: Record<string, unknown>): void {
    const message = msg.message as Record<string, unknown> | undefined
    if (!message) return
    const sessionId = msg.session_id as string | undefined

    const content = message.content as Array<Record<string, unknown>> | undefined
    if (!content || !Array.isArray(content)) return

    for (const block of content) {
      const blockType = block.type as string
      switch (blockType) {
        case "text": {
          const text = block.text as string
          if (text) {
            this.pushEvent({ type: "text_delta", text })
          }
          break
        }
        case "thinking": {
          const thinking = block.thinking as string
          if (thinking) {
            this.pushEvent({ type: "reasoning_delta", text: thinking })
          }
          break
        }
        case "tool_use": {
          const toolId = block.id as string
          const toolName = block.name as string
          const input = block.input as Record<string, unknown> | undefined
          this.activeToolUses.set(toolId, { name: toolName })
          this.pushEvent({
            type: "tool_start",
            id: toolId,
            name: toolName,
            input: input ? JSON.stringify(input) : undefined,
          })
          break
        }
      }
    }

    // Track session ID for resume
    if (sessionId && this.activeSessionID) {
      this.sessions.set(this.activeSessionID, sessionId)
    }
  }

  private handleUserEvent(msg: Record<string, unknown>): void {
    const message = msg.message as Record<string, unknown> | undefined
    if (!message) return
    const content = message.content as Array<Record<string, unknown>> | undefined
    if (!content || !Array.isArray(content)) return

    for (const block of content) {
      const blockType = block.type as string
      if (blockType === "tool_result") {
        const toolUseId = block.tool_use_id as string
        const toolInfo = this.activeToolUses.get(toolUseId)
        const isError = block.is_error as boolean | undefined
        const resultContent = block.content as string | undefined

        // Also check tool_use_result for richer data
        const toolResult = msg.tool_use_result as Record<string, unknown> | undefined
        const stdout = toolResult?.stdout as string | undefined
        const stderr = toolResult?.stderr as string | undefined

        let result = resultContent ?? stdout ?? ""
        if (stderr && !isError) {
          result = result ? `${result}\n${stderr}` : stderr
        }

        this.pushEvent({
          type: "tool_end",
          id: toolUseId,
          name: toolInfo?.name ?? "unknown",
          result,
          error: isError ? (resultContent ?? "Tool execution failed") : undefined,
        })
        this.activeToolUses.delete(toolUseId)
      }
    }
  }

  private handleResultEvent(msg: Record<string, unknown>): void {
    const sessionId = msg.session_id as string | undefined
    if (sessionId && this.activeSessionID) {
      this.sessions.set(this.activeSessionID, sessionId)
    }

    const isError = msg.is_error as boolean | undefined
    const subtype = msg.subtype as string | undefined
    const usage = msg.usage as Record<string, unknown> | undefined

    if (isError) {
      const errors = msg.errors as string[] | undefined
      const errorMsg = errors?.join("; ") ?? `Claude Code error: ${subtype ?? "unknown"}`
      this.pushEvent({ type: "error", message: errorMsg })
    }

    this.pushEvent({
      type: "turn_complete",
      usage: usage
        ? {
            inputTokens: (usage.input_tokens ?? usage.input) as number | undefined,
            outputTokens: (usage.output_tokens ?? usage.output) as number | undefined,
          }
        : undefined,
    })

    log.info("result", {
      subtype,
      isError,
      sessionId,
      durationMs: msg.duration_ms,
      costUsd: msg.total_cost_usd,
    })
  }

  // Track which Synergy session is active for session mapping
  private activeSessionID = ""

  // ---------------------------------------------------------------------------
  // Event queue
  // ---------------------------------------------------------------------------

  private pushEvent(event: ExternalAgent.BridgeEvent): void {
    this.queue.push({ event })
    this.queueResolve?.()
    this.queueResolve = undefined
  }

  private drainQueue(): void {
    this.queue.push({ done: true })
    this.queueResolve?.()
    this.queueResolve = undefined
  }

  // ---------------------------------------------------------------------------
  // Process management
  // ---------------------------------------------------------------------------

  private killCurrentProc(): void {
    const proc = this.currentProc
    this.currentProc = undefined
    if (!proc) return
    try {
      proc.kill("SIGTERM")
    } catch {}
  }
}

// Self-register
ExternalAgent.register("claude-code", () => new ClaudeCodeAdapter())
