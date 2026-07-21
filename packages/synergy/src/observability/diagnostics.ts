import fs from "fs/promises"
import path from "path"
import { tmpdir } from "os"
import { Log } from "@/util/log"
import { Global } from "@/global"
import { DaemonPaths } from "@/daemon/paths"
import { ServerProcessLock } from "@/daemon/server-process-lock"
import { ProcessRegistry } from "@/process/registry"
import { Observability } from "."
import { ObservabilityEvents } from "./events"
import { ObservabilityIssues } from "./issues"
import { ObservabilityRedaction } from "./redaction"
import { ObservabilitySchema } from "./schema"
import { ObservabilityStore } from "./store"
import { parseJson } from "@/util/json-parse"

export namespace Diagnostics {
  export type Summary = ObservabilitySchema.DiagnosticsSummary

  export interface PackageOptions {
    sessionID?: string
    sinceMs?: number
    output?: string
  }

  export async function summary(): Promise<Summary> {
    const lock = await ServerProcessLock.read().catch(() => undefined)
    const inspection = lock ? await ServerProcessLock.inspect(lock).catch(() => undefined) : undefined
    const recentErrors = ObservabilityStore.queryEvents({ limit: 200 })
      .map(ObservabilityEvents.fromRow)
      .filter((event) => event.level === "error" || event.type.endsWith(".error") || event.type.includes("error"))
      .slice(0, 50)
    const issues = ObservabilityIssues.list({ status: "open", limit: 50 })
    const inflight = ObservabilityStore.queryInflight({ limit: 100 }).map(inflightFromRow)
    const resourceRows = ObservabilityStore.resourceSince(Date.now() - 15 * 60_000, { limit: 500 })
    const resourceSamples = resourceRows.map(resourceFromRow)
    const latest = ObservabilityStore.latestResource()
    if (latest && !resourceRows.some((row) => row.sample_id === latest.sample_id)) {
      resourceSamples.push(resourceFromRow(latest))
    }

    return ObservabilitySchema.DiagnosticsSummary.parse({
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
        recentErrors,
      },
      issues,
      inflight,
      resources: {
        latest: latest ? resourceFromRow(latest) : undefined,
        samples: resourceSamples,
        pressure: resourcePressure(resourceSamples),
      },
      lock: {
        path: ServerProcessLock.path(),
        lock: summarizeLock(lock),
        inspection: summarizeInspection(inspection),
      },
      processes: {
        active: ProcessRegistry.listActive().map(summarizeProcess),
        finished: ProcessRegistry.listFinished().map(summarizeFinishedProcess),
      },
      sessions: {
        pendingReply: await pendingSessions().catch(() => []),
      },
    })
  }

  export async function createPackage(options: PackageOptions = {}) {
    const stamp = timestamp()
    const output = path.resolve(options.output ?? path.join(process.cwd(), `synergy-diagnostics-${stamp}.tar.gz`))
    const tmp = await fs.mkdtemp(path.join(tmpdir(), "synergy-diagnostics-"))
    const root = path.join(tmp, "bundle")
    await fs.mkdir(path.join(root, "logs"), { recursive: true })
    await fs.mkdir(path.join(root, "observability"), { recursive: true })
    await fs.mkdir(path.join(root, "runtime"), { recursive: true })

    const info = await summary()
    await fs.writeFile(path.join(root, "summary.json"), JSON.stringify(info, null, 2) + "\n")

    const logFiles = [info.logs.current, info.logs.dev, info.logs.daemon, ...info.logs.devArchives].filter(
      (item): item is string => Boolean(item),
    )
    for (const file of unique(logFiles)) {
      await copyLogSummary(file, path.join(root, "logs", path.basename(file)))
    }

    const events = ObservabilityStore.queryEvents({
      sessionID: options.sessionID,
      since: options.sinceMs,
      limit: 5000,
    }).map(ObservabilityEvents.fromRow)
    await fs.writeFile(
      path.join(root, "observability", "events.jsonl"),
      events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : ""),
    )

    const issues = ObservabilityStore.queryIssues({ limit: 500 })
      .map(ObservabilityIssues.fromRow)
      .filter(
        (issue) =>
          (!options.sessionID || issue.sessionID === options.sessionID) &&
          (!options.sinceMs || issue.lastSeenTime >= options.sinceMs),
      )
    await fs.writeFile(path.join(root, "observability", "issues.json"), JSON.stringify(issues, null, 2) + "\n")

    const inflight = ObservabilityStore.queryInflight({ sessionID: options.sessionID, limit: 500 }).map(inflightFromRow)
    await fs.writeFile(path.join(root, "observability", "inflight.json"), JSON.stringify(inflight, null, 2) + "\n")

    const resourceSamples = ObservabilityStore.resourceSince(options.sinceMs ?? Date.now() - 15 * 60_000, {
      limit: 5000,
    }).map(resourceFromRow)
    await fs.writeFile(
      path.join(root, "observability", "resources.json"),
      JSON.stringify(resourceSamples, null, 2) + "\n",
    )
    await fs.writeFile(path.join(root, "runtime", "processes.json"), JSON.stringify(info.processes, null, 2) + "\n")
    await fs.writeFile(
      path.join(root, "runtime", "pending-sessions.json"),
      JSON.stringify(info.sessions.pendingReply, null, 2) + "\n",
    )

    const pluginState = path.join(Global.Path.data, "plugin-runtime-state.json")
    await copyPluginStateSummary(pluginState, path.join(root, "plugin-runtime-state.json")).catch(() => {})

    const lockFile = ServerProcessLock.path()
    await copyLockSummary(lockFile, path.join(root, "runtime-lock.json")).catch(() => {})

    await fs.mkdir(path.dirname(output), { recursive: true })
    const outputDir = path.dirname(output)
    const archiveName = path.basename(output)
    const proc = Bun.spawn(["tar", "-czf", archiveName, "-C", root, "."], {
      cwd: outputDir,
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
      command: ObservabilityRedaction.commandSummary(proc.command),
      description: proc.description ? ObservabilityRedaction.text(proc.description, 160) : undefined,
      cwd: ObservabilityRedaction.cwdScope(proc.cwd),
      startedAt: proc.startedAt,
      backgrounded: proc.backgrounded,
      outputChars: ProcessRegistry.outputChars(proc),
      tailOmitted: true,
      tailChars: proc.tail.length,
      truncated: proc.truncated,
    }
  }

  function summarizeFinishedProcess(proc: ProcessRegistry.FinishedProcess) {
    return {
      id: proc.id,
      command: ObservabilityRedaction.commandSummary(proc.command),
      description: proc.description ? ObservabilityRedaction.text(proc.description, 160) : undefined,
      cwd: ObservabilityRedaction.cwdScope(proc.cwd),
      status: proc.status,
      startedAt: proc.startedAt,
      endedAt: proc.endedAt,
      exitCode: proc.exitCode,
      exitSignal: proc.exitSignal,
      outputChars: proc.output.length,
      tailOmitted: true,
      tailChars: proc.tail.length,
      truncated: proc.truncated,
    }
  }

  function inflightFromRow(
    row: ReturnType<typeof ObservabilityStore.queryInflight>[number],
  ): ObservabilitySchema.InflightSpan {
    return ObservabilitySchema.InflightSpan.parse({
      traceId: row.trace_id,
      correlationId: row.correlation_id ?? undefined,
      spanId: row.span_id,
      parentSpanId: row.parent_span_id ?? undefined,
      kind: row.kind,
      name: row.name,
      module: row.module,
      source: row.source,
      startTime: row.start_time,
      endTime: row.end_time ?? undefined,
      durationMs: row.duration_ms ?? undefined,
      lastActivityTime: row.last_activity_time ?? row.start_time,
      heartbeatTime: row.heartbeat_time ?? undefined,
      heartbeatCount: row.heartbeat_count ?? 0,
      stalled: Boolean(row.stalled),
      status: row.status,
      errorCode: row.error_code ?? undefined,
      errorMessage: row.error_message ?? undefined,
      scopeID: row.scope_id ?? undefined,
      sessionID: row.session_id ?? undefined,
      messageID: row.message_id ?? undefined,
      callID: row.call_id ?? undefined,
      rid: row.rid ?? undefined,
      processId: row.process_id ?? undefined,
      pid: row.pid ?? undefined,
      tool: row.tool ?? undefined,
      attributes: parseJson(row.attributes_json),
      redaction: parseRedaction(row.redaction_json),
      ageMs: row.age_ms,
      idleMs: row.idle_ms,
      stale: row.stale,
    })
  }

  function resourceFromRow(row: ObservabilityStore.StoredResource): ObservabilitySchema.ResourceSample {
    return ObservabilitySchema.ResourceSample.parse({
      sampleId: row.sample_id,
      time: row.time,
      iso: row.iso,
      source: row.source,
      correlationId: row.correlation_id ?? undefined,
      traceId: row.trace_id ?? undefined,
      scopeID: row.scope_id ?? undefined,
      sessionID: row.session_id ?? undefined,
      process: {
        pid: row.pid ?? undefined,
        processId: row.process_id ?? undefined,
        role: resourceRole(row.process_role),
      },
      cpu: {
        userMicros: row.cpu_user_micros ?? undefined,
        systemMicros: row.cpu_system_micros ?? undefined,
        utilizationRatio: row.cpu_utilization_ratio ?? undefined,
      },
      memory: {
        rssBytes: row.memory_rss_bytes ?? undefined,
        heapTotalBytes: row.memory_heap_total_bytes ?? undefined,
        heapUsedBytes: row.memory_heap_used_bytes ?? undefined,
        externalBytes: row.memory_external_bytes ?? undefined,
        arrayBuffersBytes: row.memory_array_buffers_bytes ?? undefined,
      },
      eventLoop: { lagMs: row.event_loop_lag_ms ?? undefined, sampleWindowMs: row.event_loop_sample_window_ms ?? 0 },
      io: {
        appReadBytes: row.app_read_bytes ?? undefined,
        appWrittenBytes: row.app_written_bytes ?? undefined,
        appReadOps: row.app_read_ops ?? undefined,
        appWriteOps: row.app_write_ops ?? undefined,
        osReadBytes: row.os_read_bytes ?? undefined,
        osWrittenBytes: row.os_written_bytes ?? undefined,
        osAvailable: Boolean(row.os_available),
      },
      labels: parseJson(row.labels_json ?? "{}"),
      redaction: parseRedaction(row.redaction_json),
    })
  }

  function resourcePressure(samples: ObservabilitySchema.ResourceSample[]) {
    const latest = samples[samples.length - 1]
    const pressure: ObservabilitySchema.Labels = {}
    const store = ObservabilityStore.stats()
    pressure.observabilityStoreAvailable = store.available
    pressure.observabilityPendingWrites = store.pending
    pressure.observabilityDroppedWrites = store.dropped
    pressure.observabilityCapExceededBytes = store.capExceededBytes
    if (store.lastOpenError) pressure.observabilityStoreError = ObservabilityRedaction.text(store.lastOpenError, 160)
    if (!latest) return pressure
    const heapUsed = latest.memory.heapUsedBytes ?? 0
    const heapTotal = latest.memory.heapTotalBytes ?? 0
    if (heapTotal > 0) pressure.heapUsedRatio = heapUsed / heapTotal
    if (latest.cpu.utilizationRatio !== undefined) pressure.cpuUtilizationRatio = latest.cpu.utilizationRatio
    if (latest.eventLoop.lagMs !== undefined) pressure.eventLoopLagMs = latest.eventLoop.lagMs
    if (latest.memory.rssBytes !== undefined) pressure.rssBytes = latest.memory.rssBytes
    const first = samples.find((sample) => sample.memory.rssBytes !== undefined)
    if (first?.memory.rssBytes !== undefined && latest.memory.rssBytes !== undefined && latest.time > first.time) {
      pressure.rssGrowthBytesPerMin =
        ((latest.memory.rssBytes - first.memory.rssBytes) / Math.max(1, latest.time - first.time)) * 60_000
    }
    return pressure
  }

  async function copyLogSummary(src: string, dest: string) {
    const stat = await fs.stat(src).catch(() => undefined)
    if (!stat) return
    if (!stat.isFile()) return
    const text = await fs.readFile(src, "utf8").catch(() => "")
    const lines = text.split(/\r?\n/).filter(Boolean)
    const recent = lines.slice(-200).map(summarizeLogLine)
    await fs.writeFile(
      dest,
      [
        `# redacted log summary`,
        `source=${path.basename(src)}`,
        `bytes=${stat.size}`,
        `lines=${lines.length}`,
        ...recent,
      ].join("\n") + "\n",
    )
  }

  async function copyLockSummary(src: string, dest: string) {
    const text = await fs.readFile(src, "utf8").catch(() => "")
    const parsed = JSON.parse(text) as ServerProcessLock.LockInfo
    await fs.writeFile(dest, JSON.stringify(summarizeLock(parsed), null, 2) + "\n")
  }

  async function copyPluginStateSummary(src: string, dest: string) {
    const text = await fs.readFile(src, "utf8").catch(() => "")
    const parsed = JSON.parse(text) as Array<Record<string, unknown>>
    const summary = parsed.slice(0, 100).map((entry) => ({
      pluginId: typeof entry.pluginId === "string" ? ObservabilityRedaction.text(entry.pluginId, 120) : undefined,
      mode: typeof entry.mode === "string" ? ObservabilityRedaction.text(entry.mode, 40) : undefined,
      pid: typeof entry.pid === "number" ? entry.pid : undefined,
      state: typeof entry.state === "string" ? ObservabilityRedaction.text(entry.state, 40) : undefined,
      restarts: typeof entry.restarts === "number" ? entry.restarts : undefined,
      lastHeartbeatAt: typeof entry.lastHeartbeatAt === "number" ? entry.lastHeartbeatAt : undefined,
      startedAt: typeof entry.startedAt === "number" ? entry.startedAt : undefined,
      lastError: typeof entry.lastError === "string" ? ObservabilityRedaction.text(entry.lastError, 256) : undefined,
      source: typeof entry.source === "string" ? ObservabilityRedaction.text(entry.source, 80) : undefined,
    }))
    await fs.writeFile(dest, JSON.stringify(summary, null, 2) + "\n")
  }

  function summarizeLogLine(line: string) {
    const match = line.match(/^(DEBUG|INFO|WARN|ERROR)\s+(\S+)\s+\+\d+ms\s+([\s\S]*)$/)
    if (!match) return `[redacted-log-line] chars=${line.length}`
    const service = match[3]?.match(/\bservice=([^\s]+)/)?.[1]
    return [
      match[1],
      match[2],
      service ? `service=${ObservabilityRedaction.text(service, 80)}` : undefined,
      `chars=${line.length}`,
      "message=[omitted]",
    ]
      .filter(Boolean)
      .join(" ")
  }

  function summarizeLock(lock: ServerProcessLock.LockInfo | undefined) {
    if (!lock) return undefined
    return {
      pid: lock.pid,
      startedAt: lock.startedAt,
      command: ObservabilityRedaction.commandSummary(lock.command.join(" ")),
      cwd: ObservabilityRedaction.cwdScope(lock.cwd),
      mode: lock.mode,
    }
  }

  function summarizeInspection(inspection: ServerProcessLock.ProcessInspection | undefined) {
    if (!inspection) return undefined
    return {
      alive: inspection.alive,
      pid: inspection.pid,
      ppid: inspection.ppid,
      pgid: inspection.pgid,
      stat: inspection.stat,
      cpu: inspection.cpu,
      memory: inspection.memory,
      elapsed: inspection.elapsed,
      command: ObservabilityRedaction.commandSummary(inspection.command),
      listeningPorts: inspection.listeningPorts,
      healthy: inspection.healthy,
      healthUrl: inspection.healthUrl ? ObservabilityRedaction.routePath(inspection.healthUrl) : undefined,
      error: inspection.error ? ObservabilityRedaction.text(inspection.error, 256) : undefined,
    }
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

  function parseRedaction(text: string | null | undefined): ObservabilitySchema.RedactionSummary {
    const parsed = text ? parseJson(text) : {}
    return ObservabilitySchema.RedactionSummary.parse({ applied: true, omittedKeys: 0, truncatedValues: 0, ...parsed })
  }

  function resourceRole(input: string | null | undefined): ObservabilitySchema.ResourceSample["process"]["role"] {
    const roles = new Set(["server", "tool", "pty", "mcp", "plugin", "desktop", "browser", "unknown"])
    return input && roles.has(input) ? (input as ObservabilitySchema.ResourceSample["process"]["role"]) : "unknown"
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
