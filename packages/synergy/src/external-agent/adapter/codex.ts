import { Log } from "@/util/log"
import { ExternalAgent } from "../bridge"

const log = Log.create({ service: "external-agent.codex" })

type QueueEntry = { event: ExternalAgent.BridgeEvent } | { done: true }

class CodexAdapter implements ExternalAgent.Adapter {
  readonly name = "codex"

  readonly capabilities: ExternalAgent.Capabilities = {
    modelSwitch: true,
    interrupt: true,
  }

  started = false
  private cwd = ""
  private adapterConfig: Record<string, unknown> = {}
  private sessions = new Map<string, string>()
  private currentProc: import("bun").Subprocess<"pipe", "pipe", "pipe"> | undefined
  private queue: QueueEntry[] = []
  private queueResolve: (() => void) | undefined
  private activeItems = new Map<string, { type: string; name: string }>()
  private env: Record<string, string | undefined> = {}

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
    this.cwd = opts.cwd
    this.adapterConfig = opts.config ?? {}
    this.env = opts.env ? { ...process.env, ...opts.env } : { ...process.env }
    this.started = true
    log.info("codex adapter started", { cwd: opts.cwd })
  }

  async *turn(context: ExternalAgent.TurnContext, signal?: AbortSignal): AsyncGenerator<ExternalAgent.BridgeEvent> {
    this.queue = []
    this.queueResolve = undefined
    this.activeItems.clear()
    this.currentSessionID = context.sessionID

    const args = this.buildArgs(context)
    log.info("spawning codex turn", { sessionID: context.sessionID, args: args.join(" ") })

    const proc = Bun.spawn(["codex", ...args], {
      cwd: this.cwd,
      env: this.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    this.currentProc = proc

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
          proc.exited.then(() => resolve())
        })
      }
    } finally {
      signal?.removeEventListener("abort", onAbort)
      this.currentProc = undefined
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
    this.started = false
    this.sessions.clear()
    log.info("codex adapter shut down")
  }

  private buildArgs(context: ExternalAgent.TurnContext): string[] {
    const threadId = this.sessions.get(context.sessionID)
    const args = threadId ? ["exec", "resume", threadId, "--json"] : ["exec", "--json"]

    const model = this.adapterConfig.model as string | undefined
    if (model) args.push("--model", model)

    const baseURL = this.adapterConfig.baseURL as string | undefined
    const providerID = this.adapterConfig.providerID as string | undefined
    if (baseURL) {
      const alias = providerID ?? "synergy"
      args.push("-c", `model_provider=\"${alias}\"`)
      args.push("-c", `model_providers.${alias}.base_url=\"${baseURL}\"`)
      if (this.env["SYNERGY_CODEX_API_KEY"]) {
        args.push("-c", `model_providers.${alias}.env_key=\"SYNERGY_CODEX_API_KEY\"`)
      }
    }

    const allowAll = this.adapterConfig.allowAll === true
    if (allowAll) {
      args.push("--dangerously-bypass-approvals-and-sandbox")
    } else {
      args.push("--sandbox", "read-only")
    }

    args.push("--skip-git-repo-check")
    args.push("-C", this.cwd)

    const prompt = composeTurnInput(context)
    args.push(prompt)
    return args
  }

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
      if (buffer.trim()) this.handleLine(buffer.trim())
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
        if (!line || line === "Reading additional input from stdin...") continue
        log.debug("codex stderr", { line: line.slice(0, 500) })
      }
    })
    nodeStream.on("error", () => {})
  }

  private handleLine(raw: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(raw)
    } catch {
      log.debug("non-json line from codex", { raw: raw.slice(0, 200) })
      return
    }

    const type = msg.type as string | undefined
    if (!type) return

    switch (type) {
      case "thread.started": {
        const threadID = msg.thread_id as string | undefined
        if (threadID && this.currentSessionID) {
          this.sessions.set(this.currentSessionID, threadID)
        }
        break
      }
      case "turn.started":
        break
      case "item.started": {
        const item = msg.item as Record<string, unknown> | undefined
        if (!item) break
        for (const event of this.mapItemStarted(item)) this.pushEvent(event)
        break
      }
      case "item.completed": {
        const item = msg.item as Record<string, unknown> | undefined
        if (!item) break
        for (const event of this.mapItemCompleted(item)) this.pushEvent(event)
        break
      }
      case "turn.completed": {
        const usage = msg.usage as Record<string, number | undefined> | undefined
        this.pushEvent({
          type: "turn_complete",
          usage: usage
            ? {
                inputTokens: usage.input_tokens ?? usage.inputTokens,
                outputTokens: usage.output_tokens ?? usage.outputTokens,
              }
            : undefined,
        })
        break
      }
      case "turn.failed": {
        this.pushEvent({ type: "error", message: String(msg.message ?? "Codex turn failed") })
        break
      }
      default:
        log.debug("unhandled codex event", { type })
    }
  }

  private currentSessionID = ""

  private mapItemStarted(item: Record<string, unknown>): ExternalAgent.BridgeEvent[] {
    const id = String(item.id ?? "")
    const type = String(item.type ?? "")

    if (type === "command_execution") {
      this.activeItems.set(id, { type, name: "shell" })
      return [
        {
          type: "tool_start",
          id,
          name: "shell",
          input: JSON.stringify({ command: item.command }),
        },
      ]
    }

    return []
  }

  private mapItemCompleted(item: Record<string, unknown>): ExternalAgent.BridgeEvent[] {
    const id = String(item.id ?? "")
    const type = String(item.type ?? "")

    if (type === "agent_message") {
      const text = extractItemText(item)
      if (!text) return []
      return [{ type: "text_delta", text }]
    }

    if (type === "command_execution") {
      this.activeItems.delete(id)
      return [
        {
          type: "tool_end",
          id,
          name: "shell",
          result: (item.aggregated_output as string | undefined) ?? "",
          error: Number(item.exit_code ?? 0) !== 0 ? `exit code ${item.exit_code}` : undefined,
        },
      ]
    }

    return []
  }

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

  private killCurrentProc(): void {
    const proc = this.currentProc
    this.currentProc = undefined
    if (!proc) return
    try {
      proc.kill("SIGTERM")
    } catch {}
  }
}

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

function extractItemText(item: Record<string, unknown>): string {
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
