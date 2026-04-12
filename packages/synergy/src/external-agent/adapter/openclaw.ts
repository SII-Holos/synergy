import { Log } from "@/util/log"
import { ExternalAgent } from "../bridge"

const log = Log.create({ service: "external-agent.openclaw" })

/**
 * OpenClaw adapter.
 *
 * Integration model: spawn `openclaw agent --local --json` per turn.
 * Multi-turn is achieved via `--session-id <id>` (persistent sessions in v2026.4.x+).
 * No mid-turn streaming in CLI mode — request-response only.
 * JSON output is on **stderr** (v2026.4.x change), stdout is empty.
 * Must strip ANSI escape codes from stderr before JSON parsing.
 *
 * Model switching is currently not wired through this adapter safely.
 * Keep modelSwitch false until the adapter explicitly applies per-turn model overrides.
 */
class OpenClawAdapter implements ExternalAgent.Adapter {
  readonly name = "openclaw"

  readonly capabilities: ExternalAgent.Capabilities = {
    modelSwitch: false,
    interrupt: true,
  }

  get started(): boolean {
    return this._started
  }

  private _started = false
  private cwd = ""
  private adapterConfig: Record<string, unknown> = {}
  private currentProc: import("bun").Subprocess<"pipe", "pipe", "pipe"> | undefined
  private env: Record<string, string | undefined> = {}

  async discover(): Promise<{ available: boolean; path?: string; version?: string }> {
    const binPath = Bun.which("openclaw")
    if (!binPath) return { available: false }

    try {
      const proc = Bun.spawn(["openclaw", "--version"], {
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
    log.info("openclaw adapter started", { cwd: opts.cwd })
  }

  async *turn(context: ExternalAgent.TurnContext, signal?: AbortSignal): AsyncGenerator<ExternalAgent.BridgeEvent> {
    const args = this.buildArgs(context)
    log.info("spawning openclaw turn", { sessionID: context.sessionID, args: args.join(" ") })

    const proc = Bun.spawn(["openclaw", ...args], {
      cwd: this.cwd,
      env: this.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    this.currentProc = proc

    // Close stdin immediately
    try {
      proc.stdin.end()
    } catch {}

    const onAbort = () => {
      log.warn("turn aborted via signal")
      this.killCurrentProc()
    }
    signal?.addEventListener("abort", onAbort, { once: true })

    try {
      // OpenClaw CLI is request-response — wait for process to complete
      const [stderrText, stdoutText] = await Promise.all([
        new Response(proc.stderr).text(),
        new Response(proc.stdout).text(),
        proc.exited,
      ])
      this.currentProc = undefined

      const exitCode = proc.exitCode ?? -1
      log.info("openclaw process exited", { exitCode, stderrLen: stderrText.length, stdoutLen: stdoutText.length })

      // v2026.4.x: JSON is on stderr; strip ANSI codes
      const result = this.parseResponse(stderrText, stdoutText)

      if (!result) {
        yield {
          type: "error",
          message: `OpenClaw returned no parseable response (exit ${exitCode})`,
        }
        yield { type: "turn_complete" }
        return
      }

      // Emit text content
      const text = this.extractText(result)
      if (text) {
        yield { type: "text_delta", text }
      }

      // Emit usage and turn_complete
      const usage = this.extractUsage(result)
      yield { type: "turn_complete", usage }

      // Check for errors
      if (result.meta?.aborted) {
        yield { type: "error", message: "OpenClaw turn was aborted" }
      }
    } finally {
      signal?.removeEventListener("abort", onAbort)
      this.currentProc = undefined
    }
  }

  async interrupt(): Promise<void> {
    this.killCurrentProc()
  }

  async shutdown(): Promise<void> {
    this.killCurrentProc()
    this._started = false
    log.info("openclaw adapter shut down")
  }

  // ---------------------------------------------------------------------------
  // Argument building
  // ---------------------------------------------------------------------------

  private buildArgs(context: ExternalAgent.TurnContext): string[] {
    const args = ["agent", "--local", "--json"]

    // Session ID for continuity — use Synergy session ID directly
    args.push("--session-id", `synergy-${context.sessionID}`)

    // Timeout
    const timeout = this.adapterConfig.timeout as number | undefined
    args.push("--timeout", String(timeout ?? 300))

    // Thinking level
    const thinking = this.adapterConfig.thinking as string | undefined
    if (thinking) args.push("--thinking", thinking)

    // The prompt
    const prompt = context.taskContext ? `${context.taskContext}\n\n${context.prompt}` : context.prompt
    args.push("-m", prompt)

    return args
  }

  // ---------------------------------------------------------------------------
  // Response parsing
  // ---------------------------------------------------------------------------

  private stripAnsi(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1b\[[0-9;]*m/g, "")
  }

  private parseResponse(stderrText: string, stdoutText: string): OpenClawResponse | undefined {
    // v2026.4.x: JSON is on stderr
    for (const raw of [stderrText, stdoutText]) {
      const clean = this.stripAnsi(raw)
      const jsonStart = clean.indexOf("{")
      if (jsonStart === -1) continue
      try {
        return JSON.parse(clean.slice(jsonStart)) as OpenClawResponse
      } catch {
        // Try finding the last complete JSON object
        const lastBrace = clean.lastIndexOf("}")
        if (lastBrace > jsonStart) {
          try {
            return JSON.parse(clean.slice(jsonStart, lastBrace + 1)) as OpenClawResponse
          } catch {}
        }
      }
    }
    log.warn("no parseable JSON in openclaw output")
    return undefined
  }

  private extractText(result: OpenClawResponse): string | undefined {
    // Prefer finalAssistantVisibleText (v2026.4.x)
    if (result.meta?.finalAssistantVisibleText) {
      return result.meta.finalAssistantVisibleText
    }
    // Fallback to payloads
    if (result.payloads && result.payloads.length > 0) {
      return result.payloads
        .map((p) => p.text)
        .filter(Boolean)
        .join("\n")
    }
    return undefined
  }

  private extractUsage(result: OpenClawResponse): { inputTokens?: number; outputTokens?: number } | undefined {
    const usage = result.meta?.agentMeta?.usage
    if (!usage) return undefined
    return {
      inputTokens: usage.input ?? undefined,
      outputTokens: usage.output ?? undefined,
    }
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

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

interface OpenClawResponse {
  payloads?: Array<{
    text?: string
    mediaUrl?: string | null
  }>
  meta?: {
    durationMs?: number
    agentMeta?: {
      sessionId?: string
      sessionKey?: string
      provider?: string
      model?: string
      usage?: {
        input?: number
        output?: number
        cacheRead?: number
        cacheWrite?: number
        total?: number
      }
    }
    aborted?: boolean
    finalAssistantVisibleText?: string
    stopReason?: string
  }
}

// Self-register
ExternalAgent.register("openclaw", () => new OpenClawAdapter())
