import { spawn } from "child_process"
import path from "path"
import { realpathSync } from "fs"
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

const DEFAULT_TIMEOUT_S = 2 * 60

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
    if (params.timeout !== undefined && params.timeout < 0) {
      throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
    }
    const timeout = params.timeout ?? DEFAULT_TIMEOUT_S
    const tree = await parser().then((p) => p.parse(params.command))
    if (!tree) {
      throw new Error("Failed to parse command")
    }
    const directories = new Set<string>()
    if (!Instance.contains(cwd)) directories.add(cwd)
    const patterns = new Set<string>()

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

      if (["cd", "rm", "cp", "mv", "mkdir", "touch", "chmod", "chown"].includes(command[0])) {
        for (const arg of command.slice(1)) {
          if (arg.startsWith("-") || (command[0] === "chmod" && arg.startsWith("+"))) continue
          let resolved: string | undefined
          try {
            resolved = realpathSync(path.resolve(cwd, arg))
          } catch {
            // path doesn't exist — skip
          }
          log.info("resolved path", { arg, resolved })
          if (resolved) {
            const normalized =
              process.platform === "win32" && resolved.match(/^\/[a-z]\//)
                ? resolved.replace(/^\/([a-z])\//, (_, drive) => `${drive.toUpperCase()}:\\`).replace(/\//g, "\\")
                : resolved
            if (!Instance.contains(normalized)) directories.add(normalized)
          }
        }
      }

      if (command.length && command[0] !== "cd") {
        patterns.add(command.join(" "))
      }
    }

    if (directories.size > 0) {
      await ctx.ask({
        permission: "external_directory",
        patterns: Array.from(directories),
        metadata: {},
      })
    }

    if (patterns.size > 0) {
      await ctx.ask({
        permission: "bash",
        patterns: Array.from(patterns),
        metadata: {},
      })
    }

    const child = spawn(params.command, {
      shell,
      cwd,
      env: {
        ...process.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    })

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

    const append = (chunk: Buffer) => {
      const text = chunk.toString()
      ProcessRegistry.appendOutput(regProc, text)
      ctx.metadata({
        metadata: {
          output: truncateMetadataOutput(regProc.output),
          description: params.description,
        },
      })
    }

    child.stdout?.on("data", append)
    child.stderr?.on("data", append)

    child.once("exit", (code, signal) => {
      if (params.background || regProc.backgrounded) {
        ProcessRegistry.markExited(regProc, code, signal)
      } else {
        ProcessRegistry.remove(regProc.id)
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

    let timedOut = false
    let aborted = false
    let exited = false
    let yielded = false

    const kill = () => Shell.killTree(child, { exited: () => exited })

    if (ctx.abort.aborted) {
      aborted = true
      await kill()
    }

    const abortHandler = () => {
      aborted = true
      void kill()
    }

    ctx.abort.addEventListener("abort", abortHandler, { once: true })

    const timeoutTimer = setTimeout(
      () => {
        timedOut = true
        void kill()
      },
      timeout * 1000 + 100,
    )

    const yieldS = params.yieldSeconds
    const yieldResult = await new Promise<"exited" | "yielded" | "error">((resolve, reject) => {
      const yieldTimer = yieldS
        ? setTimeout(() => {
            yielded = true
            resolve("yielded")
          }, yieldS * 1000)
        : undefined

      const cleanup = () => {
        clearTimeout(timeoutTimer)
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

    const resultMetadata: string[] = []

    if (timedOut) {
      resultMetadata.push(`bash tool terminated command after exceeding timeout ${timeout}s`)
    }

    if (aborted) {
      resultMetadata.push("User aborted the command")
    }

    const output = regProc.output

    if (resultMetadata.length > 0) {
      return {
        title: params.description,
        metadata: {
          output: truncateMetadataOutput(
            output + "\n\n<bash_metadata>\n" + resultMetadata.join("\n") + "\n</bash_metadata>",
          ),
          exit: child.exitCode,
          description: params.description,
          backend: "local",
        },
        output: output + "\n\n<bash_metadata>\n" + resultMetadata.join("\n") + "\n</bash_metadata>",
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
