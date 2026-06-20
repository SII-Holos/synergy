import { spawn } from "child_process"
import { fileURLToPath } from "url"
import { Language } from "web-tree-sitter"
import { $ } from "bun"
import { lazy } from "@/util/lazy"
import { Shell } from "@/util/shell"
import { Log } from "@/util/log"
import { Instance } from "@/scope/instance"
import { ProcessRegistry } from "@/process/registry"
import type { BashBackend } from "./shared"
import { truncateMetadataOutput } from "./shared"
import { SandboxBackend } from "@/sandbox/backend"
import { EnforcementError } from "@/enforcement/errors"
import { ShellSafety } from "@/enforcement/shell-safety"

/**
 * Derive a human-readable abort reason from an AbortSignal's .reason.
 */
function deriveAbortReason(reason: unknown): string {
  if (reason instanceof DOMException) {
    if (reason.name === "TimeoutError") {
      return "The command was interrupted: tool execution timed out."
    }
    if (typeof reason.message === "string" && reason.message.includes("Turn timed out")) {
      return "The command was interrupted: session turn timed out."
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

export const LocalBashBackend: BashBackend = {
  async execute(params, ctx) {
    const shell = Shell.acceptable()
    log.info("bash tool using shell", { shell })

    const cwd = params.workdir || Instance.directory
    const tree = await parser().then((p) => p.parse(params.command))
    if (!tree) {
      throw new Error("Failed to parse command")
    }
    const patterns = new Set<string>()

    try {
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

    if (patterns.size > 0 && (ctx.extra as any)?.shellBypassSandbox !== true) {
      await ctx.ask({
        permission: "bash",
        patterns: Array.from(patterns),
        metadata: {
          capability: ShellSafety.capability(params.command),
        },
      })
    }

    const sandboxWrapper =
      (ctx.extra as any)?.shellBypassSandbox === true ? undefined : (ctx.extra as any)?.sandboxWrapper
    const sandboxFallback = (ctx.extra as any)?.sandboxFallback as "deny" | "warn" | "allow" | undefined

    // Build sandbox-safe environment from the backend allowlist
    const sandboxEnv: Record<string, string> = {}
    for (const key of SandboxBackend.SANDBOX_ENV_ALLOWLIST) {
      const val = process.env[key]
      if (val !== undefined) {
        sandboxEnv[key] = val
      }
    }
    // ── ProcessRegistry setup (shared across both paths) ──────────
    const regProc = ProcessRegistry.create({
      command: params.command,
      description: params.description,
      cwd,
    })

    ctx.metadata({
      metadata: {
        output: "",
        description: params.description,
      },
    })

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

    const append = (chunk: Buffer) => {
      ProcessRegistry.appendOutput(regProc, chunk.toString())
      scheduleMetadata()
    }

    // ── Synchronous sandboxed execution via unified sandbox path ──
    // executeAsync handles env allowlist, timeout, output cap, signal,
    // sandbox denial detection, and temp cleanup — all in one call.
    if (sandboxWrapper && !sandboxWrapper.skipReason && !params.background && !params.yieldSeconds) {
      try {
        const result = await SandboxBackend.executeAsync(sandboxWrapper, {
          fallbackPolicy: sandboxFallback ?? "warn",
          env: sandboxEnv,
          cwd,
          signal: ctx.abort,
          timeoutMs: 3_600_000, // 60-minute hard ceiling
          maxOutputBytes: 1024 * 1024, // 1 MB
          onStdout: append,
          onStderr: append,
        })

        if (metadataDirty) flushMetadata()

        if (ctx.abort.aborted || result.timedOut) {
          const abortReason = deriveAbortReason(ctx.abort.reason)
          const abortTag = `\n\n<bash_metadata>\n${abortReason}\n</bash_metadata>`
          ProcessRegistry.remove(regProc.id)
          return {
            title: params.description,
            metadata: {
              output: truncateMetadataOutput(regProc.output + abortTag),
              exit: result.exitCode,
              description: params.description,
              backend: "local",
            },
            output: regProc.output + abortTag,
          }
        }

        ProcessRegistry.remove(regProc.id)
        return {
          title: params.description,
          metadata: {
            output: truncateMetadataOutput(regProc.output),
            exit: result.exitCode,
            description: params.description,
            backend: "local",
          },
          output: regProc.output,
        }
      } catch (e: unknown) {
        ProcessRegistry.remove(regProc.id)
        if (e instanceof EnforcementError.SandboxBlocked) throw e
        throw e
      }
    }

    let child: ReturnType<typeof spawn>
    if (sandboxWrapper && !sandboxWrapper.skipReason) {
      // Sandboxed path: use allowlisted env
      child = spawn(sandboxWrapper.command, sandboxWrapper.args, {
        cwd,
        env: sandboxEnv,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      })
    } else {
      // Unsandboxed path: check for deny policy on skip
      if (sandboxWrapper?.skipReason && sandboxFallback === "deny") {
        throw new Error(`Sandbox required but unavailable: ${sandboxWrapper.skipReason}`)
      }
      if (sandboxWrapper?.skipReason) {
        log.warn("sandbox unavailable, running unsandboxed", {
          reason: sandboxWrapper.skipReason,
          fallback: sandboxFallback,
        })
      }
      child = spawn(params.command, {
        shell,
        cwd,
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      })
    }
    // Wire the spawned child into the existing ProcessRegistry entry
    regProc.child = child
    regProc.stdin = child.stdin ?? undefined
    regProc.pid = child.pid

    child.stdout?.on("data", append)
    child.stderr?.on("data", append)

    child.once("exit", (code, signal) => {
      if (metadataDirty) flushMetadata()
      if (params.background || regProc.backgrounded) {
        ProcessRegistry.markExited(regProc, code, signal)
      } else {
        ProcessRegistry.remove(regProc.id)
      }
      if (sandboxWrapper?.tempPath) {
        SandboxBackend.cleanupTemp(sandboxWrapper.tempPath)
      }
    })

    if (params.background) {
      ProcessRegistry.markBackgrounded(regProc)
      return {
        title: `[Background] ${params.description}`,
        metadata: {
          output: "",
          description: params.description,
          processId: regProc.id,
          background: true,
          backend: "local",
        },
        output:
          `Command started in background.\n\n` +
          `Process ID: ${regProc.id}\n` +
          `Command: ${params.command}\n` +
          `Status: running\n\n` +
          `Use \`process(action: "log", processId: "${regProc.id}")\` to get current output (non-blocking).\n` +
          `Use \`process(action: "poll", processId: "${regProc.id}")\` to check status.\n` +
          `Use \`process(action: "kill", processId: "${regProc.id}")\` to terminate.`,
      }
    }

    let aborted = false
    let exited = false
    let yielded = false

    const HARD_BASH_CEILING_MS = 3_600_000 // 60 minutes absolute hard limit

    const kill = () => Shell.killTree(child, { exited: () => exited })

    const hardCeilingTimer = setTimeout(() => {
      if (!exited && !yielded) {
        log.warn("bash hard ceiling reached, killing", { description: params.description })
        kill()
      }
    }, HARD_BASH_CEILING_MS)

    if (ctx.abort.aborted) {
      aborted = true
      clearTimeout(hardCeilingTimer)
      await kill()
    }

    const abortHandler = () => {
      aborted = true
      clearTimeout(hardCeilingTimer)
      void kill()
    }

    ctx.abort.addEventListener("abort", abortHandler, { once: true })

    const yieldS = params.yieldSeconds
    const yieldResult = await new Promise<"exited" | "yielded" | "error">((resolve, reject) => {
      const yieldTimer = yieldS
        ? setTimeout(() => {
            yielded = true
            resolve("yielded")
          }, yieldS * 1000)
        : undefined

      const cleanup = () => {
        clearTimeout(hardCeilingTimer)
        if (yieldTimer) clearTimeout(yieldTimer)
        ctx.abort.removeEventListener("abort", abortHandler)
      }

      child.once("exit", () => {
        exited = true
        cleanup()
        resolve("exited")
      })

      child.once("error", (error) => {
        exited = true
        cleanup()
        ProcessRegistry.remove(regProc.id)
        if (sandboxWrapper?.tempPath) {
          SandboxBackend.cleanupTemp(sandboxWrapper.tempPath)
        }
        reject(error)
      })
    })

    if (yieldResult === "yielded") {
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
        output:
          `Command auto-backgrounded after ${yieldS}s.\n\n` +
          `Process ID: ${regProc.id}\n` +
          `Command: ${params.command}\n` +
          `Status: running\n\n` +
          `Recent output:\n${regProc.tail || "(no output yet)"}\n\n` +
          `Use \`process(action: "log", processId: "${regProc.id}")\` to get current output (non-blocking).\n` +
          `Use \`process(action: "poll", processId: "${regProc.id}")\` to check status.\n` +
          `Use \`process(action: "kill", processId: "${regProc.id}")\` to terminate.`,
      }
    }

    const output = regProc.output
    const abortReason = deriveAbortReason(ctx.abort.reason)
    const abortTag = `\n\n<bash_metadata>\n${abortReason}\n</bash_metadata>`
    if (aborted) {
      return {
        title: params.description,
        metadata: {
          output: truncateMetadataOutput(output + abortTag),
          exit: child.exitCode,
          description: params.description,
          backend: "local",
        },
        output: output + abortTag,
      }
    }

    return {
      title: params.description,
      metadata: {
        output: truncateMetadataOutput(output),
        exit: child.exitCode,
        description: params.description,
        backend: "local",
      },
      output,
    }
  },
}
