import path from "node:path"
import { BunProc } from "../util/bun.js"
import { Log } from "../util/log"
import { BrowserHostControl } from "./host-control.js"
import { BrowserOwner } from "./owner.js"

export namespace BrowserElectronHostProcess {
  export interface EnsureInput {
    owner: BrowserOwner.Info
    pageId: string
    serverUrl: string
    routeDirectory: string
    url?: string
    width?: number
    height?: number
    traceId?: string
  }

  export type EnsureResult = { status: "disabled" | "running" | "started" | "restarted" | "failed"; key: string }

  type HostSubprocess = Bun.Subprocess<"ignore", "ignore" | "pipe", "ignore" | "pipe">

  interface ProcessEntry {
    proc: HostSubprocess
    owner: BrowserOwner.Info
    pageId: string
    routeDirectory: string
    startedAt: number
    lastEnsureAt: number
    lastControlAttachedAt: number | null
    restartCount: number
    lastExitReason?: string
  }

  const processes = new Map<string, ProcessEntry>()
  const log = Log.create({ service: "browser.host.process" })

  export function key(owner: BrowserOwner.Info, pageId: string): string {
    return `${BrowserOwner.key(owner)}:page:${pageId}`
  }

  export function enabled(): boolean {
    const configured = process.env.SYNERGY_BROWSER_HOST_AUTOSTART?.trim().toLowerCase()
    if (configured === "0" || configured === "false") return false
    return true
  }

  export function ensure(input: EnsureInput): EnsureResult {
    const processKey = key(input.owner, input.pageId)
    const now = Date.now()
    const existing = processes.get(processKey)
    log.info("browser.host.process.ensure", {
      ownerKey: BrowserOwner.key(input.owner),
      pageId: input.pageId,
      hostProcessKey: processKey,
      routeDirectory: input.routeDirectory,
      hostStatus: BrowserHostControl.status(input.owner, input.pageId),
      traceId: input.traceId,
    })

    if (existing?.proc.exitCode === null) {
      existing.lastEnsureAt = now
      if (BrowserHostControl.isReady(input.owner, input.pageId)) {
        existing.lastControlAttachedAt = now
        log.info("browser.host.process.reused", {
          ownerKey: BrowserOwner.key(input.owner),
          pageId: input.pageId,
          hostProcessKey: processKey,
          pid: existing.proc.pid,
          hostStatus: "ready",
          traceId: input.traceId,
        })
        return { status: "running", key: processKey }
      }

      const elapsed = now - existing.startedAt
      if (elapsed < readyTimeoutMs()) {
        BrowserHostControl.markStatus(input.owner, input.pageId, "pending", {
          reason: "host_process_starting",
          traceId: input.traceId,
        })
        log.info("browser.host.process.reused", {
          ownerKey: BrowserOwner.key(input.owner),
          pageId: input.pageId,
          hostProcessKey: processKey,
          pid: existing.proc.pid,
          hostStatus: "pending",
          durationMs: elapsed,
          traceId: input.traceId,
        })
        return { status: "running", key: processKey }
      }

      if (existing.restartCount >= restartLimit()) {
        BrowserHostControl.markStatus(input.owner, input.pageId, "failed", {
          reason: "host_control_not_ready",
          traceId: input.traceId,
        })
        log.error("browser.host.process.failed", {
          ownerKey: BrowserOwner.key(input.owner),
          pageId: input.pageId,
          hostProcessKey: processKey,
          pid: existing.proc.pid,
          restartCount: existing.restartCount,
          durationMs: elapsed,
          reason: "host_control_not_ready",
          traceId: input.traceId,
        })
        return { status: "failed", key: processKey }
      }

      BrowserHostControl.markStatus(input.owner, input.pageId, "restarting", {
        reason: "host_control_not_ready",
        traceId: input.traceId,
      })
      existing.proc.kill()
      processes.delete(processKey)
      return start(input, processKey, existing.restartCount + 1, "restarted")
    }

    if (!enabled()) return { status: "disabled", key: processKey }

    return start(input, processKey, existing?.restartCount ?? 0, "started")
  }

  function start(
    input: EnsureInput,
    processKey: string,
    restartCount: number,
    status: "started" | "restarted",
  ): EnsureResult {
    if (!enabled()) return { status: "disabled", key: processKey }
    BrowserHostControl.markStatus(input.owner, input.pageId, status === "restarted" ? "restarting" : "pending", {
      reason: status === "restarted" ? "host_process_restart" : "host_process_start",
      traceId: input.traceId,
    })
    const shouldPipeLogs = hostLogEnabled()
    const proc = Bun.spawn(command(), {
      cwd: repoRoot(),
      stdout: shouldPipeLogs ? "pipe" : "ignore",
      stderr: shouldPipeLogs ? "pipe" : "ignore",
      env: {
        ...process.env,
        SYNERGY_DESKTOP_MODE: "browser-host",
        SYNERGY_BROWSER_HOST_SERVER_URL: input.serverUrl,
        SYNERGY_BROWSER_HOST_SESSION_ID: input.owner.sessionID ?? "",
        SYNERGY_BROWSER_HOST_PAGE_ID: input.pageId,
        SYNERGY_BROWSER_HOST_ROUTE_DIRECTORY: input.routeDirectory,
        SYNERGY_BROWSER_HOST_DIRECTORY: input.owner.directory,
        SYNERGY_BROWSER_HOST_SCOPE_ID: input.owner.scopeID ?? "",
        SYNERGY_BROWSER_HOST_URL: input.url ?? "",
        SYNERGY_BROWSER_HOST_WIDTH: String(input.width ?? 1280),
        SYNERGY_BROWSER_HOST_HEIGHT: String(input.height ?? 720),
        SYNERGY_BROWSER_HOST_TRACE_ID: input.traceId ?? "",
      },
    })
    const entry: ProcessEntry = {
      proc,
      owner: input.owner,
      pageId: input.pageId,
      routeDirectory: input.routeDirectory,
      startedAt: Date.now(),
      lastEnsureAt: Date.now(),
      lastControlAttachedAt: null,
      restartCount,
    }
    processes.set(processKey, entry)
    log.info(status === "restarted" ? "browser.host.process.restarted" : "browser.host.process.started", {
      ownerKey: BrowserOwner.key(input.owner),
      pageId: input.pageId,
      hostProcessKey: processKey,
      pid: proc.pid,
      routeDirectory: input.routeDirectory,
      restartCount,
      traceId: input.traceId,
    })
    if (shouldPipeLogs) {
      pipeProcessStream(proc.stdout, "stdout", processKey)
      pipeProcessStream(proc.stderr, "stderr", processKey)
    }
    proc.exited.finally(() => {
      const current = processes.get(processKey)
      if (current?.proc !== proc) return
      current.lastExitReason = `exitCode:${proc.exitCode}`
      processes.delete(processKey)
      BrowserHostControl.markStatus(input.owner, input.pageId, "detached", {
        reason: current.lastExitReason,
        traceId: input.traceId,
      })
      log.info("browser.host.process.exited", {
        ownerKey: BrowserOwner.key(input.owner),
        pageId: input.pageId,
        hostProcessKey: processKey,
        pid: proc.pid,
        exitCode: proc.exitCode,
        restartCount,
        traceId: input.traceId,
      })
    })
    return { status, key: processKey }
  }

  export function stop(owner: BrowserOwner.Info, pageId: string): void {
    const processKey = key(owner, pageId)
    const entry = processes.get(processKey)
    if (!entry) return
    entry.proc.kill()
    processes.delete(processKey)
    BrowserHostControl.markStatus(owner, pageId, "detached", { reason: "host_process_stopped" })
  }

  export function resetForTest(): void {
    for (const entry of processes.values()) entry.proc.kill()
    processes.clear()
  }

  function command(): string[] {
    const configured = process.env.SYNERGY_BROWSER_HOST_COMMAND
    if (configured) {
      if (configured.trim().startsWith("[")) return JSON.parse(configured)
      return configured.split(/\s+/).filter(Boolean)
    }
    return [BunProc.which(), "run", "--cwd", desktopDir(), "dev"]
  }

  function repoRoot(): string {
    return path.resolve(import.meta.dir, "../../..")
  }

  function desktopDir(): string {
    return path.resolve(import.meta.dir, "../../../desktop")
  }

  function readyTimeoutMs(): number {
    const configured = Number(process.env.SYNERGY_BROWSER_HOST_READY_TIMEOUT_MS)
    return Number.isFinite(configured) && configured >= 0 ? configured : 5_000
  }

  function restartLimit(): number {
    const configured = Number(process.env.SYNERGY_BROWSER_HOST_RESTART_LIMIT)
    return Number.isFinite(configured) && configured >= 0 ? configured : 1
  }

  function hostLogEnabled(): boolean {
    const configured = process.env.SYNERGY_BROWSER_HOST_LOG?.trim().toLowerCase()
    if (configured === "1" || configured === "true") return true
    if (configured === "0" || configured === "false") return false
    return process.env.NODE_ENV !== "production"
  }

  function pipeProcessStream(
    stream: ReadableStream<Uint8Array> | null | undefined,
    streamName: "stdout" | "stderr",
    processKey: string,
  ): void {
    if (!stream) return
    void (async () => {
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split(/\r?\n/)
          buffer = lines.pop() ?? ""
          for (const line of lines) {
            if (!line.trim()) continue
            log.info("browser.host.process.output", { hostProcessKey: processKey, stream: streamName, line })
          }
        }
        const tail = buffer + decoder.decode()
        if (tail.trim()) {
          log.info("browser.host.process.output", { hostProcessKey: processKey, stream: streamName, line: tail })
        }
      } catch (error) {
        log.warn("browser.host.process.output.failed", {
          hostProcessKey: processKey,
          stream: streamName,
          error: error instanceof Error ? error.message : String(error),
        })
      } finally {
        reader.releaseLock()
      }
    })()
  }
}
