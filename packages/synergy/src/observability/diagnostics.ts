import fs from "fs/promises"
import path from "path"
import { tmpdir } from "os"
import { Log } from "@/util/log"
import { Global } from "@/global"
import { DaemonPaths } from "@/daemon/paths"
import { ServerProcessLock } from "@/daemon/server-process-lock"
import { ProcessRegistry } from "@/process/registry"
import { Observability } from "."

export namespace Diagnostics {
  export interface Summary {
    generatedAt: string
    logs: {
      current?: string
      dev?: string
      daemon?: string
      devArchives: string[]
    }
    traces: {
      directory: string
      files: string[]
      recentErrors: Observability.Event[]
    }
    lock?: {
      path: string
      lock?: ServerProcessLock.LockInfo
      inspection?: ServerProcessLock.ProcessInspection
    }
    processes: {
      active: Array<ReturnType<typeof summarizeProcess>>
      finished: Array<ReturnType<typeof summarizeFinishedProcess>>
    }
    sessions: {
      pendingReply: Array<{
        sessionID: string
        path: string
        updated?: number
      }>
    }
  }

  export interface PackageOptions {
    sessionID?: string
    sinceMs?: number
    output?: string
  }

  export async function summary(): Promise<Summary> {
    const lock = await ServerProcessLock.read().catch(() => undefined)
    const inspection = lock
      ? await ServerProcessLock.inspect(lock, { healthUrl: "http://127.0.0.1:4096" }).catch(() => undefined)
      : undefined
    const traceEvents = await Observability.query({ limit: 200 })
    const recentErrors = traceEvents.filter(
      (event) => event.level === "error" || event.type.endsWith(".error") || event.type.includes("error"),
    )

    return {
      generatedAt: new Date().toISOString(),
      logs: {
        current: Log.file(),
        dev: Log.devFile(),
        daemon: DaemonPaths.logFile(),
        devArchives: await Log.listDevArchives().catch(() => []),
      },
      traces: {
        directory: Observability.dir(),
        files: await Observability.listFiles().catch(() => []),
        recentErrors: recentErrors.slice(0, 50),
      },
      lock: {
        path: ServerProcessLock.path(),
        lock,
        inspection,
      },
      processes: {
        active: ProcessRegistry.listActive().map(summarizeProcess),
        finished: ProcessRegistry.listFinished().map(summarizeFinishedProcess),
      },
      sessions: {
        pendingReply: await pendingSessions().catch(() => []),
      },
    }
  }

  export async function createPackage(options: PackageOptions = {}) {
    const stamp = timestamp()
    const output = path.resolve(options.output ?? path.join(process.cwd(), `synergy-diagnostics-${stamp}.tar.gz`))
    const tmp = await fs.mkdtemp(path.join(tmpdir(), "synergy-diagnostics-"))
    const root = path.join(tmp, "bundle")
    await fs.mkdir(path.join(root, "logs"), { recursive: true })
    await fs.mkdir(path.join(root, "traces"), { recursive: true })

    const info = await summary()
    await fs.writeFile(path.join(root, "summary.json"), JSON.stringify(info, null, 2) + "\n")

    const logFiles = [info.logs.current, info.logs.dev, info.logs.daemon, ...info.logs.devArchives].filter(
      (item): item is string => Boolean(item),
    )
    for (const file of unique(logFiles)) {
      await copyTextFile(file, path.join(root, "logs", path.basename(file)))
    }

    const traceEvents = await Observability.query({
      sessionID: options.sessionID,
      since: options.sinceMs,
      limit: 5000,
    })
    const traceBody = traceEvents.map((event) => JSON.stringify(event)).join("\n")
    await fs.writeFile(path.join(root, "traces", "filtered.jsonl"), traceBody ? traceBody + "\n" : "")

    for (const file of await Observability.listFiles().catch(() => [])) {
      await copyTextFile(file, path.join(root, "traces", path.basename(file)))
    }

    const pluginState = path.join(Global.Path.data, "plugin-runtime-state.json")
    await copyTextFile(pluginState, path.join(root, "plugin-runtime-state.json")).catch(() => {})

    const lockFile = ServerProcessLock.path()
    await copyTextFile(lockFile, path.join(root, "runtime-lock.json")).catch(() => {})

    await fs.mkdir(path.dirname(output), { recursive: true })
    const proc = Bun.spawn(["tar", "-czf", output, "-C", root, "."], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const code = await proc.exited
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text().catch(() => "")
      throw new Error(`failed to create diagnostics package: ${stderr || `tar exited ${code}`}`)
    }
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
    return { output, summary: info }
  }

  function summarizeProcess(proc: ProcessRegistry.Process) {
    return {
      id: proc.id,
      pid: proc.pid,
      command: proc.command,
      description: proc.description,
      cwd: proc.cwd,
      startedAt: proc.startedAt,
      backgrounded: proc.backgrounded,
      outputChars: proc.output.length,
      tail: Observability.sanitizeText(proc.tail),
      truncated: proc.truncated,
    }
  }

  function summarizeFinishedProcess(proc: ProcessRegistry.FinishedProcess) {
    return {
      id: proc.id,
      command: proc.command,
      description: proc.description,
      cwd: proc.cwd,
      status: proc.status,
      startedAt: proc.startedAt,
      endedAt: proc.endedAt,
      exitCode: proc.exitCode,
      exitSignal: proc.exitSignal,
      outputChars: proc.output.length,
      tail: Observability.sanitizeText(proc.tail),
      truncated: proc.truncated,
    }
  }

  async function copyTextFile(src: string, dest: string) {
    const stat = await fs.stat(src).catch(() => undefined)
    if (!stat) return
    if (!stat.isFile()) return
    const text = await fs.readFile(src, "utf8").catch(() => "")
    await fs.writeFile(dest, Observability.sanitizeText(text))
  }

  async function pendingSessions() {
    const root = path.join(Global.Path.data, "sessions")
    const result: Summary["sessions"]["pendingReply"] = []
    await walk(root, async (file) => {
      if (!file.endsWith("info.json")) return
      const data = await fs.readFile(file, "utf8").catch(() => "")
      if (!data.includes('"pendingReply"')) return
      const json = JSON.parse(data) as { id?: string; pendingReply?: boolean; time?: { updated?: number } }
      if (!json.pendingReply || !json.id) return
      result.push({ sessionID: json.id, path: file, updated: json.time?.updated })
    })
    return result.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0)).slice(0, 50)
  }

  async function walk(dir: string, visit: (file: string) => Promise<void>) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    await Promise.all(
      entries.map(async (entry) => {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) return walk(full, visit)
        if (entry.isFile()) return visit(full)
      }),
    )
  }

  function unique(items: string[]) {
    return [...new Set(items)]
  }

  function timestamp() {
    const date = new Date()
    const pad = (n: number) => String(n).padStart(2, "0")
    return (
      String(date.getFullYear()) +
      pad(date.getMonth() + 1) +
      pad(date.getDate()) +
      "-" +
      pad(date.getHours()) +
      pad(date.getMinutes()) +
      pad(date.getSeconds())
    )
  }
}
