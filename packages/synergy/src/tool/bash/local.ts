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
import { SandboxDetector } from "@/enforcement/sandbox-detector"
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

    if (patterns.size > 0 && (ctx.extra as any)?.shellApprovedByUser !== true) {
      await ctx.ask({
        permission: "bash",
        patterns: Array.from(patterns),
        metadata: {
          capability: ShellSafety.capability(params.command),
        },
      })
    }

    const sandboxWrapper =
      (ctx.extra as any)?.shellApprovedByUser === true ? undefined : (ctx.extra as any)?.sandboxWrapper
    const sandboxFallback = (ctx.extra as any)?.sandboxFallback as "deny" | "warn" | "allow" | undefined

    let child: ReturnType<typeof spawn>
    if (sandboxWrapper) {
      if (sandboxWrapper.skipReason) {
        if (sandboxFallback === "deny") {
          throw new Error(`Sandbox required but unavailable: ${sandboxWrapper.skipReason}`)
        }
        log.warn("sandbox unavailable, running unsandboxed", {
          reason: sandboxWrapper.skipReason,
          fallback: sandboxFallback,
        })
        child = spawn(params.command, {
          shell,
          cwd,
          env: {
            ...process.env,
          },
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
        })
      } else {
        child = spawn(sandboxWrapper.command, sandboxWrapper.args, {
          cwd,
          env: {
            ...process.env,
          },
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
        })
      }
    } else {
      child = spawn(params.command, {
        shell,
        cwd,
        env: {
          ...process.env,
        },
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      })
    }

    const regProc = ProcessRegistry.create({
      command: params.command,
      description: params.description,
      cwd,
      child,
      stdin: child.stdin ?? undefined,
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
      const text = chunk.toString()
      ProcessRegistry.appendOutput(regProc, text)
      scheduleMetadata()
    }

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
    // ── Sandbox denial detection ──────────────────────────────────
    // When the sandbox is active and the command fails, scan output
    // for OS-level permission denial patterns. If matched, throw a
    // structured SandboxBlocked error that tells the model this is
    // a boundary, not a transient technical failure.
    const sandboxActive = sandboxWrapper?.sandboxed === true && !sandboxWrapper?.skipReason
    if (sandboxActive && child.exitCode !== null && child.exitCode !== 0) {
      const matches = SandboxDetector.scan(output)
      if (matches.length > 0) {
        throw new EnforcementError.SandboxBlocked(
          SandboxDetector.explain(matches),
          child.exitCode,
          matches[0]?.label ?? null,
          output,
        )
      }
    }

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
