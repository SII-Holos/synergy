import { spawn } from "child_process"
import { fileURLToPath } from "url"
import { Language } from "web-tree-sitter"
import { $ } from "bun"
import { lazy } from "@/util/lazy"
import { Shell } from "@/util/shell"
import { Log } from "@/util/log"
import { ScopeContext } from "@/scope/context"
import { ProcessRegistry } from "@/process/registry"
import { truncateMetadataOutput } from "./shared"
import { SandboxBackend } from "@/sandbox/backend"
import { ShellSafety } from "@/enforcement/shell-safety"
import { AttachmentDiscovery } from "../attachment-discovery"
import type { MessageV2 } from "@/session/message-v2"
import type { BashParams } from "./shared"
import type { BashContext } from "./shared"
import type { BashResult } from "./shared"
import { Observability } from "@/observability"
import { ToolTimeout } from "../timeout"
import { GitHubProvider } from "@/provider/github"
import { BashVirtualFile } from "./virtual-file"
import type { BashSandboxPrepare } from "./shared"

/**
 * Derive a human-readable abort reason from an AbortSignal's .reason.
 */
function deriveAbortReason(reason: unknown): string {
  if (reason instanceof DOMException) {
    if (reason.name === "TimeoutError") {
      return "The command was interrupted: tool execution timed out."
    }
    if (typeof reason.message === "string" && reason.message.includes("Assistant step timed out")) {
      return "The command was interrupted: assistant step timed out."
    }
    return "The command was interrupted: " + (reason.message || reason.name)
  }
  if (typeof reason === "string" && reason.length > 0) {
    return "The command was interrupted: " + reason
  }
  return "The command was interrupted."
}

const log = Log.create({ service: "bash-tool" })

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const bashLanguage = await Language.load(bashPath)
  const p = new Parser()
  p.setLanguage(bashLanguage)
  return p
})

function isGitHubCliCommand(pattern: string) {
  const [command] = pattern.trim().split(/\s+/)
  if (!command) return false
  const normalized = command.replace(/^["']|["']$/g, "")
  return normalized === "gh" || normalized.endsWith("/gh") || normalized.endsWith("\\gh.exe")
}

function canInjectGitHubCliToken(patterns: Set<string>) {
  if (patterns.size === 0) return false
  return Array.from(patterns).every(isGitHubCliCommand)
}

const ALLOW_DETACHED_DAEMONS_ENV = "SYNERGY_BASH_ALLOW_DETACHED_DAEMONS"

export type DetachedDaemonRisk = {
  kind: "tmux_detached" | "nohup" | "setsid" | "disown" | "daemonize" | "screen_detached" | "shell_background"
  pattern: string
}

export function detectDetachedDaemonRisk(command: string): DetachedDaemonRisk | undefined {
  const checks: Array<{ kind: DetachedDaemonRisk["kind"]; pattern: string; regex: RegExp }> = [
    {
      kind: "tmux_detached",
      pattern: "tmux new-session -d",
      regex: /\btmux\s+(?:new-session|new)\b(?=[\s\S]*?(?:^|\s)-d(?:\s|$))/,
    },
    {
      kind: "screen_detached",
      pattern: "screen -dm",
      regex: /\bscreen\s+-dm(?:\w|$)/,
    },
    {
      kind: "nohup",
      pattern: "nohup",
      regex: /(?:^|[;&|]\s*)nohup(?:\s|$)/,
    },
    {
      kind: "setsid",
      pattern: "setsid",
      regex: /(?:^|[;&|]\s*)setsid(?:\s|$)/,
    },
    {
      kind: "disown",
      pattern: "disown",
      regex: /(?:^|[;&|]\s*)disown(?:\s|$)/,
    },
    {
      kind: "daemonize",
      pattern: "daemonize",
      regex: /(?:^|[;&|]\s*)daemonize(?:\s|$)/,
    },
    {
      kind: "shell_background",
      pattern: "&",
      regex: /\s&\s*(?:$|[;\n\r)]|\s+\w)/,
    },
  ]
  for (const check of checks) {
    if (check.regex.test(command)) return { kind: check.kind, pattern: check.pattern }
  }
}

function allowsDetachedDaemons(ctx: BashContext) {
  const extra = ctx.extra as Record<string, unknown> | undefined
  if (extra?.shellAllowDetachedDaemons === true) return true
  const controlProfile = extra?.controlProfile as string | undefined
  if (controlProfile === "full_access") return true
  const value = process.env[ALLOW_DETACHED_DAEMONS_ENV]?.toLowerCase()
  return value === "1" || value === "true" || value === "yes"
}

function detachedDaemonBlockMessage(risk: DetachedDaemonRisk) {
  return [
    `Blocked detached daemon launch pattern: ${risk.pattern}`,
    "Detached shell daemons stay inside the Synergy service cgroup and can keep consuming MemoryHigh/MemoryMax after the tool call appears settled.",
    "Use the bash tool's background/yieldSeconds flow for tracked processes, or set SYNERGY_BASH_ALLOW_DETACHED_DAEMONS=1 only for an operator-managed runtime that intentionally permits detached daemons.",
  ].join("\n")
}

export const LocalBashBackend = {
  async execute(params: BashParams, ctx: BashContext): Promise<BashResult> {
    const shell = Shell.acceptable()
    log.info("bash tool using shell", { shell })

    const cwd = params.workdir || ScopeContext.current.directory
    const traceId = ((ctx.extra as any)?.traceId as string | undefined) ?? Observability.traceId("bash")
    let regProc: ProcessRegistry.Process | undefined
    const trace = (type: string, data?: Record<string, unknown>, level?: Observability.Event["level"]) =>
      Observability.emit(type, {
        traceId,
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        callID: ctx.callID,
        tool: "bash",
        processId: regProc?.id,
        pid: regProc?.pid,
        cwd,
        scopeID: ScopeContext.current.scope.id,
        level,
        data,
      })

    await trace("bash.parser.start", {
      command: params.command,
      shell,
    })
    const tree = await parser().then((p) => p.parse(params.command))
    if (!tree) {
      await trace("bash.parser.error", { reason: "parse returned empty tree" }, "error")
      throw new Error("Failed to parse command")
    }
    const patterns = new Set<string>()
    let virtualFileReferences: BashVirtualFile.Reference[] = []

    try {
      virtualFileReferences = BashVirtualFile.references(tree.rootNode)
      for (const node of tree.rootNode.descendantsOfType("command")) {
        if (!node) continue
        const command = []
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i)
          if (!child) continue
          if (
            child.type !== "command_name" &&
            child.type !== "word" &&
            child.type !== "string" &&
            child.type !== "raw_string" &&
            child.type !== "concatenation"
          ) {
            continue
          }
          command.push(child.text)
        }

        if (command.length && command[0] !== "cd") {
          patterns.add(command.join(" "))
        }
      }
    } finally {
      tree.delete()
    }
    await trace("bash.parser.end", {
      patternCount: patterns.size,
      patterns: Array.from(patterns),
    })

    const detachedRisk = detectDetachedDaemonRisk(params.command)
    if (detachedRisk && !allowsDetachedDaemons(ctx)) {
      await trace(
        "bash.detached_daemon.blocked",
        {
          risk: detachedRisk,
          allowEnv: ALLOW_DETACHED_DAEMONS_ENV,
        },
        "warn",
      )
      throw new Error(detachedDaemonBlockMessage(detachedRisk))
    }

    if (patterns.size > 0 && (ctx.extra as any)?.shellBypassSandbox !== true) {
      await trace("bash.permission.ask", {
        patterns: Array.from(patterns),
        capability: ShellSafety.capability(params.command),
      })
      await ctx.ask({
        permission: "bash",
        patterns: Array.from(patterns),
        metadata: {
          capability: ShellSafety.capability(params.command),
        },
      })
      await trace("bash.permission.resolved", {
        patterns: Array.from(patterns),
      })
    }

    const sandboxFallback = (ctx.extra as any)?.sandboxFallback as "deny" | "warn" | "allow" | undefined
    let sandboxWarning: string | undefined
    const warnOutput = (base: string) => (sandboxWarning ? `[Sandbox unavailable: ${sandboxWarning}]\n\n${base}` : base)
    const withAttachments = async (result: BashResult): Promise<BashResult> => {
      if (AttachmentDiscovery.shouldSkip(params.command)) return result
      await trace("attachment.discovery.start", {
        outputChars: result.output.length,
      })
      const attachments = await AttachmentDiscovery.discover({
        output: result.output,
        cwd,
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        tool: "bash",
      })
        .then(async (items) => {
          await trace("attachment.discovery.end", {
            attachmentCount: items.length,
            attachments: items.map((item) => ({
              filename: item.filename,
              mime: item.mime,
              size: (
                (item.metadata as Record<string, unknown> | undefined)?.attachment as
                  | Record<string, unknown>
                  | undefined
              )?.size,
              url: item.url,
            })),
          })
          return items
        })
        .catch(async (error): Promise<MessageV2.AttachmentPart[]> => {
          await trace(
            "attachment.discovery.error",
            {
              error:
                error instanceof Error
                  ? { name: error.name, message: error.message, stack: error.stack }
                  : String(error),
            },
            "error",
          )
          return []
        })
      if (attachments.length === 0) return result
      return {
        ...result,
        attachments: [...(result.attachments ?? []), ...attachments],
      }
    }

    // Build sandbox-safe environment from the backend allowlist
    const sandboxEnv: Record<string, string> = {}
    for (const key of SandboxBackend.SANDBOX_ENV_ALLOWLIST) {
      const val = process.env[key]
      if (val !== undefined) {
        sandboxEnv[key] = val
      }
    }
    if (canInjectGitHubCliToken(patterns) && !sandboxEnv.GH_TOKEN && !sandboxEnv.GITHUB_TOKEN) {
      const github = await GitHubProvider.resolveToken()
      if (github?.token) {
        sandboxEnv.GH_TOKEN = github.token
        await trace("bash.github.token.injected", {
          source: github.source,
          authKind: github.authKind,
        })
      }
    }

    const materialized = await BashVirtualFile.materialize({
      command: params.command,
      references: virtualFileReferences,
      scopeID: ScopeContext.current.scope.id,
    })
    const sandboxPrepare = (ctx.extra as { sandboxPrepare?: BashSandboxPrepare } | undefined)?.sandboxPrepare
    let sandboxWrapper: Awaited<ReturnType<BashSandboxPrepare>> | undefined
    let artifactsCleaned = false
    const cleanupExecutionArtifacts = () => {
      if (artifactsCleaned) return
      artifactsCleaned = true
      if (sandboxWrapper?.tempPath) {
        SandboxBackend.cleanupTemp(sandboxWrapper.tempPath)
      }
      materialized.cleanup()
    }

    try {
      if ((ctx.extra as any)?.shellBypassSandbox !== true) {
        sandboxWrapper = await sandboxPrepare?.({
          command: materialized.command,
          extraReadRoots: materialized.extraReadRoots,
        })
      }
      sandboxWarning = sandboxWrapper?.skipReason
    } catch (error) {
      cleanupExecutionArtifacts()
      throw error
    }

    // ── ProcessRegistry setup (shared across both paths) ──────────
    try {
      regProc = ProcessRegistry.create({
        command: params.command,
        description: params.description,
        cwd,
      })
    } catch (error) {
      cleanupExecutionArtifacts()
      throw error
    }
    try {
      await trace("bash.process.registered", {
        processId: regProc.id,
      })

      ctx.metadata({
        metadata: {
          output: "",
          description: params.description,
        },
      })
    } catch (error) {
      ProcessRegistry.remove(regProc.id)
      cleanupExecutionArtifacts()
      throw error
    }

    const METADATA_THROTTLE_MS = 500
    let metadataTimer: ReturnType<typeof setTimeout> | null = null
    let metadataDirty = false

    const flushMetadata = () => {
      if (metadataTimer) {
        clearTimeout(metadataTimer)
        metadataTimer = null
      }
      metadataDirty = false
      ctx.metadata({
        metadata: {
          output: truncateMetadataOutput(regProc.output),
          description: params.description,
        },
      })
    }

    const scheduleMetadata = () => {
      metadataDirty = true
      if (!metadataTimer) {
        metadataTimer = setTimeout(flushMetadata, METADATA_THROTTLE_MS)
      }
    }

    let sawOutput = false
    const append = (chunk: Buffer) => {
      if (!sawOutput) {
        sawOutput = true
        void trace("bash.first_output", {
          bytes: chunk.length,
        })
      }
      ProcessRegistry.appendOutput(regProc, chunk.toString())
      scheduleMetadata()
    }

    let child: ReturnType<typeof spawn>
    try {
      if (sandboxWrapper && !sandboxWrapper.skipReason) {
        child = spawn(sandboxWrapper.command, sandboxWrapper.args, {
          cwd,
          env: sandboxEnv,
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
        })
      } else {
        if (sandboxWrapper?.skipReason && sandboxFallback === "deny") {
          throw new Error(`Sandbox required but unavailable: ${sandboxWrapper.skipReason}`)
        }
        if (sandboxWrapper?.skipReason) {
          log.warn("sandbox unavailable, running unsandboxed", {
            reason: sandboxWrapper.skipReason,
            fallback: sandboxFallback,
          })
        }
        child = spawn(materialized.command, {
          shell,
          cwd,
          env: sandboxEnv,
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
        })
      }
    } catch (e: unknown) {
      ProcessRegistry.remove(regProc.id)
      cleanupExecutionArtifacts()
      await trace(
        "bash.child.error",
        {
          error: e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : String(e),
        },
        "error",
      )
      throw e
    }

    let aborted = false
    let timedOut = false
    let timeoutMarkerAdded = false
    let hardCeilingReached = false
    let exited = false
    let childError: Error | undefined
    let resolveChildFinished: (result: "exited" | "error") => void = () => {}
    const childFinished = new Promise<"exited" | "error">((resolve) => {
      resolveChildFinished = resolve
    })

    const appendTimeoutMarker = (message: string) => {
      if (timeoutMarkerAdded) return
      timeoutMarkerAdded = true
      ProcessRegistry.appendOutput(regProc, `\n\n<bash_metadata>\n${message}\n</bash_metadata>`)
      scheduleMetadata()
    }

    const kill = () => Shell.killTree(child, { exited: () => exited })

    let hardCeilingTimer: ReturnType<typeof setTimeout> | undefined
    let commandTimeoutTimer: ReturnType<typeof setTimeout> | undefined
    let autoBackgroundTimer: ReturnType<typeof setTimeout> | undefined
    let resolveTimeout: (() => void) | undefined
    const commandTimeout = new Promise<"timeout">((resolve) => {
      resolveTimeout = () => resolve("timeout")
    })

    const cleanupForegroundWait = () => {
      if (autoBackgroundTimer) {
        clearTimeout(autoBackgroundTimer)
        autoBackgroundTimer = undefined
      }
      ctx.abort.removeEventListener("abort", abortHandler)
    }

    const cleanupAllTimers = () => {
      cleanupForegroundWait()
      if (hardCeilingTimer) {
        clearTimeout(hardCeilingTimer)
        hardCeilingTimer = undefined
      }
      if (commandTimeoutTimer) {
        clearTimeout(commandTimeoutTimer)
        commandTimeoutTimer = undefined
      }
    }

    const timeoutMessage = () =>
      hardCeilingReached
        ? "The command was interrupted: bash hard ceiling timed out."
        : `The command was interrupted: command timed out after ${params.timeoutSeconds}s.`

    child.once("error", (error) => {
      childError = error
      exited = true
      cleanupAllTimers()
      ProcessRegistry.remove(regProc.id)
      cleanupExecutionArtifacts()
      void trace(
        "bash.child.error",
        {
          error: { name: error.name, message: error.message, stack: error.stack },
        },
        "error",
      )
      resolveChildFinished("error")
    })

    regProc.child = child
    regProc.stdin = child.stdin ?? undefined
    regProc.pid = child.pid

    child.stdout?.on("data", append)
    child.stderr?.on("data", append)

    child.once("exit", (code, signal) => {
      exited = true
      cleanupAllTimers()
      if (metadataDirty) flushMetadata()
      const exitSignal = timedOut ? "SIGTERM" : signal
      if (regProc.backgrounded) {
        ProcessRegistry.markExited(regProc, code, exitSignal)
      } else if (backgroundAfterSeconds > 0) {
        // Process finished before the auto-background timer fired; still
        // persist through markExited so tests and callers can find it.
        ProcessRegistry.markExited(regProc, code, exitSignal)
      } else {
        ProcessRegistry.remove(regProc.id)
      }
      cleanupExecutionArtifacts()
      void trace("bash.child.exit", {
        exitCode: code,
        exitSignal: signal,
        outputChars: regProc?.output.length ?? 0,
      })
      resolveChildFinished("exited")
    })

    const backgroundAfterSeconds = params.backgroundAfterSeconds ?? 30

    await trace("process.spawn", {
      processId: regProc.id,
      pid: child.pid,
      command: params.command,
      sandboxed: Boolean(sandboxWrapper && !sandboxWrapper.skipReason),
      backgroundAfterSeconds,
      timeoutSeconds: params.timeoutSeconds,
    })
    if (childError) throw childError

    hardCeilingTimer = setTimeout(() => {
      if (exited) return
      hardCeilingReached = true
      timedOut = true
      log.warn("bash hard ceiling reached, killing", { description: params.description })
      appendTimeoutMarker(timeoutMessage())
      void kill()
      resolveTimeout?.()
    }, ToolTimeout.DEFAULTS.bashHardCeilingMs)

    if (params.timeoutSeconds !== undefined) {
      commandTimeoutTimer = setTimeout(() => {
        if (exited) return
        timedOut = true
        appendTimeoutMarker(timeoutMessage())
        void trace("bash.command.timeout", {
          timeoutSeconds: params.timeoutSeconds,
        })
        void kill()
        resolveTimeout?.()
      }, params.timeoutSeconds * 1000)
    }

    if (ctx.abort.aborted) {
      aborted = true
      cleanupAllTimers()
      await kill()
    }

    function abortHandler() {
      aborted = true
      cleanupAllTimers()
      void kill()
      setTimeout(() => {
        if (!exited && regProc) {
          regProc.exited = true
          ProcessRegistry.markExited(regProc, -1, "SIGKILL")
        }
      }, 30_000)
    }

    ctx.abort.addEventListener("abort", abortHandler, { once: true })

    const autoBackground = new Promise<"background">((resolve) => {
      if (backgroundAfterSeconds <= 0) return
      autoBackgroundTimer = setTimeout(() => {
        if (!exited) resolve("background")
      }, backgroundAfterSeconds * 1000)
    })

    const waitResult = await Promise.race([childFinished.then((result) => result), autoBackground, commandTimeout])

    if (waitResult === "error") {
      throw childError ?? new Error("Bash child process failed")
    }

    if (waitResult === "timeout") {
      cleanupForegroundWait()
      await childFinished
    }

    if (waitResult === "background") {
      cleanupForegroundWait()
      if (!exited) {
        ProcessRegistry.markBackgrounded(regProc)
        return {
          title: `[Auto-Background] ${params.description}`,
          metadata: {
            output: truncateMetadataOutput(regProc.output),
            description: params.description,
            processId: regProc.id,
            background: true,
            backend: "local",
          },
          output: warnOutput(
            `Command auto-backgrounded after ${backgroundAfterSeconds}s.\n\n` +
              `Process ID: ${regProc.id}\n` +
              `Command: ${params.command}\n` +
              `Status: running\n\n` +
              `Recent output:\n${regProc.tail || "(no output yet)"}\n\n` +
              `Use \`process(action: "log", processId: "${regProc.id}")\` to get current output (non-blocking).\n` +
              `Use \`process(action: "poll", processId: "${regProc.id}")\` to check status.\n` +
              `Use \`process(action: "kill", processId: "${regProc.id}")\` to terminate.`,
          ),
        }
      }
    }

    cleanupAllTimers()

    const output = regProc.output
    const abortReason = deriveAbortReason(ctx.abort.reason)
    const abortTag = `\n\n<bash_metadata>\n${abortReason}\n</bash_metadata>`
    if (timedOut) {
      return {
        title: params.description,
        metadata: {
          output: truncateMetadataOutput(output),
          exit: child.exitCode,
          description: params.description,
          backend: "local",
        },
        output: warnOutput(output),
      }
    }

    if (aborted) {
      return {
        title: params.description,
        metadata: {
          output: truncateMetadataOutput(output + abortTag),
          exit: child.exitCode,
          description: params.description,
          backend: "local",
        },
        output: warnOutput(output + abortTag),
      }
    }

    return withAttachments({
      title: params.description,
      metadata: {
        output: truncateMetadataOutput(output),
        exit: child.exitCode,
        description: params.description,
        backend: "local",
      },
      output: warnOutput(output),
    })
  },
}
