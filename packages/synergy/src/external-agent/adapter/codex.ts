import { Log } from "@/util/log"
import { ExternalAgent } from "../bridge"
import { ExternalAgentProcessTracker } from "../process-tracker"

const log = Log.create({ service: "external-agent.codex" })

type QueueEntry = { event: ExternalAgent.BridgeEvent } | { done: true }

const BASE_ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "CODEX_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
])

const CONFIG_ENV_ALLOWLIST = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "CODEX_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
])

const INJECTED_ENV_ALLOWLIST = new Set(["SYNERGY_CODEX_API_KEY"])
const CODEX_SANDBOX_ALLOWLIST = new Set(["read-only", "workspace-write"])

function copyAllowedEnv(
  target: Record<string, string>,
  source: Record<string, string | undefined>,
  allowlist: Set<string>,
) {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || !allowlist.has(key)) continue
    target[key] = value
  }
}

export function buildCodexProcessEnv(
  processEnv: Record<string, string | undefined>,
  injectedEnv: Record<string, string | undefined> = {},
  configEnv: Record<string, string | undefined> = {},
): Record<string, string> {
  const env: Record<string, string> = {}
  copyAllowedEnv(env, processEnv, BASE_ENV_ALLOWLIST)
  copyAllowedEnv(env, injectedEnv, INJECTED_ENV_ALLOWLIST)
  copyAllowedEnv(env, configEnv, CONFIG_ENV_ALLOWLIST)
  return env
}

export function normalizeCodexSandbox(value: unknown): "read-only" | "workspace-write" | undefined {
  return typeof value === "string" && CODEX_SANDBOX_ALLOWLIST.has(value)
    ? (value as "read-only" | "workspace-write")
    : undefined
}

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
  private stderrBuffer = ""
  private gotStdoutEvents = false

  async discover(config?: Record<string, unknown>): Promise<{ available: boolean; path?: string; version?: string }> {
    const binPath = resolveCodexCommandPath(config)
    if (!binPath) return { available: false }

    try {
      const proc = Bun.spawn([binPath, "--version"], {
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
    this.env = { ...(opts.env ?? {}) }
    this.started = true
    log.info("codex adapter started", { cwd: opts.cwd })
  }

  async *turn(context: ExternalAgent.TurnContext, signal?: AbortSignal): AsyncGenerator<ExternalAgent.BridgeEvent> {
    this.queue = []
    this.queueResolve = undefined
    this.activeItems.clear()
    this.currentSessionID = context.sessionID
    this.stderrBuffer = ""
    this.gotStdoutEvents = false

    // Re-apply configEnv every turn — adapterConfig may be updated by invoke.ts
    // between turns (Object.assign(cfg, runConfig)). Only allowlisted env keys
    // are forwarded to avoid leaking the Synergy process environment to Codex.
    const configEnv = (this.adapterConfig.env as Record<string, string> | undefined) ?? {}
    const currentEnv = buildCodexProcessEnv(process.env, this.env, configEnv)
    if (this.adapterConfig.nativeAuth === true) {
      delete currentEnv.SYNERGY_CODEX_API_KEY
    }
    const prompt = composeTurnInput(context)

    const command = this.commandPath()
    const args = this.buildArgs(context)
    const fullArgs = [...args]

    log.info("spawning codex turn", { sessionID: context.sessionID, command, args: fullArgs.join(" ") })

    const proc = Bun.spawn([command, ...fullArgs], {
      cwd: this.cwd,
      env: currentEnv,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    this.currentProc = proc
    const tracked = ExternalAgentProcessTracker.attach({
      adapter: this.name,
      pid: proc.pid,
      cwd: this.cwd,
      context,
    })

    try {
      proc.stdin.write(prompt)
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
      tracked.dispose()
      signal?.removeEventListener("abort", onAbort)
      this.currentProc = undefined

      const exitCode = proc.exitCode ?? -1
      if (exitCode !== 0 && !this.gotStdoutEvents && !signal?.aborted) {
        const errMsg = this.stderrBuffer.trim() || `Codex exited with code ${exitCode}`
        log.error("codex process failed", { exitCode, stderr: errMsg.slice(0, 500) })
        yield { type: "error", message: errMsg }
        yield { type: "turn_complete" }
      }

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
    const isResume = !!threadId
    const args = isResume ? ["exec", "resume", threadId, "--json"] : ["exec", "--json"]

    const model = this.adapterConfig.model as string | undefined
    if (model) args.push("--model", model)

    const baseURL = this.adapterConfig.baseURL as string | undefined
    const providerID = this.adapterConfig.providerID as string | undefined
    const nativeAuth = this.adapterConfig.nativeAuth === true
    if (!nativeAuth && baseURL) {
      const alias = providerID ?? "synergy"
      args.push("-c", `model_provider="${alias}"`)
      args.push("-c", `model_providers.${alias}.name="${alias}"`)
      args.push("-c", `model_providers.${alias}.base_url="${baseURL}"`)
      if (this.env["SYNERGY_CODEX_API_KEY"]) {
        args.push("-c", `model_providers.${alias}.env_key="SYNERGY_CODEX_API_KEY"`)
      }
    }

    const controlProfile = this.adapterConfig.controlProfile as string | undefined
    const rawSandbox = this.adapterConfig.sandbox
    const sandbox = normalizeCodexSandbox(rawSandbox)

    if (controlProfile === "full_access") {
      args.push("--dangerously-bypass-approvals-and-sandbox")
    } else if (sandbox) {
      args.push("--sandbox", sandbox)
    } else if (rawSandbox !== undefined) {
      log.warn("ignoring unsupported codex sandbox value", { sandbox: String(rawSandbox) })
      if (!isResume) args.push("--sandbox", "read-only")
    } else if (!isResume) {
      args.push("--sandbox", "read-only")
    }

    args.push("--skip-git-repo-check")
    if (!isResume) {
      args.push("-C", this.cwd)
    }
    args.push("-")
    return args
  }

  private commandPath(): string {
    return resolveCodexCommandPath(this.adapterConfig) ?? "codex"
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
        this.stderrBuffer += line + "\n"
        log.debug("codex stderr", { line: line.slice(0, 500) })
      }
    })
    nodeStream.on("end", () => {
      if (buffer.trim()) {
        const trimmed = buffer.trim()
        if (trimmed !== "Reading additional input from stdin...") {
          this.stderrBuffer += trimmed + "\n"
        }
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

    this.gotStdoutEvents = true
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
  parts.push(
    [
      "<handoff-guidance>",
      "Inspect the repository in a targeted way before editing. Prefer rg and specific known files over broad scans, avoid exhaustive searches unless necessary, and avoid repeated status or log checks when one current check is enough.",
      "</handoff-guidance>",
    ].join("\n"),
  )
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

export function resolveCodexCommandPath(config?: Record<string, unknown>): string | undefined {
  const configured = config?.path
  if (typeof configured === "string" && configured.trim()) return configured
  return Bun.which("codex") ?? undefined
}
