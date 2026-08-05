import * as fs from "fs/promises"
import path from "path"
import os from "os"
import { randomUUID } from "crypto"
import { Session } from "../index"
import { SessionImport } from "../session-import"
import { SessionExport } from "../session-export"
import { Scope } from "../../scope"
import { ScopeContext } from "../../scope/context"
import { parseClaudeCodeTranscript, type ClaudeCodeConvertOptions, decodeProjectDir } from "./claude-code"
import { parseCodexTranscript, type CodexConvertOptions } from "./codex"
import type { ForeignImportStats } from "./shared"
import { Log } from "@/util/log"

/**
 * Orchestration layer for importing foreign coding-agent session transcripts
 * (Claude Code / Codex) into Synergy.
 *
 * Three capabilities:
 * - `scanCandidates` — list candidate transcript files under the default
 *   (`~/.claude/projects`, `~/.codex/sessions` + `archived_sessions`) or a
 *   custom directory, with lightweight title/date probes.
 * - `importFile` / `importText` — convert a single transcript and write it
 *   through `SessionImport.fromReport()`, rolling back every session created
 *   by the failed attempt when the write path throws.
 * - `start`/`getJob`/`currentSummary`/`cancel` — a server-owned batch import
 *   job with durable aggregate progress, mirroring the experience reencode
 *   job pattern so the frontend can poll and render a progress bar.
 */

export namespace ForeignImport {
  const log = Log.create({ service: "session.foreign-import" })

  export type Source = "claude-code" | "codex"

  export interface Candidate {
    source: Source
    path: string
    title: string
    created: number
    updated: number
    sizeBytes: number
    sidechain: boolean
  }

  export interface ImportFileOptions {
    source: Source
    includeSidechains?: boolean
    includeThinking?: boolean
    /** Optional display path used in job items; defaults to the file path. */
    label?: string
  }

  export interface ImportFileResult {
    result: SessionImport.Result
    stats: ForeignImportStats
  }

  export type JobItemStatus = "pending" | "running" | "ok" | "failed"

  export interface JobItem {
    path: string
    status: JobItemStatus
    title?: string
    sessionID?: string
    error?: string
  }

  export interface JobState {
    id: string
    source: Source
    status: "running" | "completed" | "cancelled" | "failed"
    totalCount: number
    completedCount: number
    okCount: number
    failedCount: number
    startedAt: number
    completedAt: number | null
    error: string | null
    items: JobItem[]
  }

  export type JobSummary = Omit<JobState, "items">

  const jobs = new Map<string, JobState>()
  const controllers = new Map<string, AbortController>()
  const running = new Map<string, Promise<void>>()

  /** Default transcript root for a source, honoring $CLAUDE_CONFIG_DIR / $CODEX_HOME. */
  export function defaultRoot(source: Source): string {
    const home = os.homedir()
    if (source === "claude-code") {
      const base = process.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude")
      return path.join(base, "projects")
    }
    const base = process.env.CODEX_HOME ?? path.join(home, ".codex")
    return path.join(base, "sessions")
  }

  /** Recursively list candidate `.jsonl` transcript files for a source. */
  export async function scanCandidates(source: Source, rootDir?: string): Promise<Candidate[]> {
    const root = rootDir ?? defaultRoot(source)
    const roots = [root]
    // Codex keeps archived rollouts in a sibling `archived_sessions/` directory;
    // include them when scanning the default location.
    if (source === "codex" && !rootDir) {
      const parent = path.dirname(root)
      roots.push(path.join(parent, "archived_sessions"))
    }

    const files: string[] = []
    for (const dir of roots) {
      files.push(...(await collectJsonlFiles(dir, source)))
    }

    const unique = [...new Set(files)]
    const candidates: Candidate[] = []
    for (const file of unique) {
      const candidate = await candidateFromFile(source, file)
      if (candidate) candidates.push(candidate)
    }
    return candidates.sort((a, b) => b.updated - a.updated)
  }

  async function collectJsonlFiles(dir: string, source: Source): Promise<string[]> {
    const out: string[] = []
    const walk = async (current: string) => {
      let entries
      try {
        entries = await fs.readdir(current, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
          continue
        }
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue
        // Claude Code subagent transcripts share the project directory and are
        // excluded by default, matching the converter's sidechain handling.
        if (source === "claude-code" && entry.name.startsWith("agent-")) continue
        out.push(full)
      }
    }
    await walk(dir)
    return out
  }

  async function candidateFromFile(source: Source, file: string): Promise<Candidate | undefined> {
    let stat
    try {
      stat = await fs.stat(file)
    } catch {
      return undefined
    }
    if (!stat.isFile() || stat.size === 0) return undefined
    const title = await probeTitle(source, file)
    const created =
      source === "codex"
        ? (codexTimestampFromName(file) ?? stat.birthtimeMs ?? stat.mtimeMs)
        : (stat.birthtimeMs ?? stat.mtimeMs)
    return {
      source,
      path: file,
      title,
      created,
      updated: stat.mtimeMs,
      sizeBytes: stat.size,
      sidechain: path.basename(file).startsWith("agent-"),
    }
  }

  /**
   * Lightweight title probe that reads only a bounded slice of the file:
   * Claude Code summaries land near the end of the transcript, Codex session
   * metadata at the start.
   */
  async function probeTitle(source: Source, file: string): Promise<string> {
    const basename = path.basename(file)
    try {
      const handle = Bun.file(file)
      const probeBytes = 256 * 1024
      const size = handle.size
      const start = source === "claude-code" ? Math.max(0, size - probeBytes) : 0
      const buf = await handle.slice(start, start + probeBytes).arrayBuffer()
      const text = new TextDecoder().decode(buf)
      const options = {}
      if (source === "claude-code") {
        const { report } = parseClaudeCodeTranscript(text, options as ClaudeCodeConvertOptions)
        return report.sessions[0]?.info.title ?? basename
      }
      const { report } = parseCodexTranscript(text, options as CodexConvertOptions)
      return report.sessions[0]?.info.title ?? basename
    } catch {
      return basename
    }
  }

  function codexTimestampFromName(file: string): number | undefined {
    const match = /rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/.exec(path.basename(file))
    if (!match) return undefined
    const ms = Date.parse(match[1].replace(/-(\d{2})-(\d{2})$/, ":$1:$2"))
    return Number.isFinite(ms) ? ms : undefined
  }

  /** Parse a transcript into a Synergy export report, tolerating format drift. */
  export function parseTranscript(
    source: Source,
    text: string,
    options: Pick<ImportFileOptions, "includeSidechains" | "includeThinking"> & { cwd?: string } = {},
  ): { report: SessionExport.Report; stats: ForeignImportStats } {
    if (source === "claude-code") {
      const { report, stats } = parseClaudeCodeTranscript(text, {
        includeSidechains: options.includeSidechains,
        includeThinking: options.includeThinking,
        cwd: options.cwd,
      })
      return { report, stats }
    }
    const { report, stats } = parseCodexTranscript(text, { includeReasoning: options.includeThinking })
    return { report, stats }
  }

  // Cache resolved scopes per working directory so batch imports of many
  // transcripts from the same project do not re-run git discovery per file.
  const scopeCache = new Map<string, Scope>()

  /**
   * Resolve the Synergy scope that owns a transcript's original working
   * directory. When the directory exists, `Scope.fromDirectory` reuses the
   * existing scope or persists a new one (same behavior as opening the
   * directory in Synergy). When the directory is missing or unknown, fall
   * back to the caller's current scope.
   */
  export async function resolveTranscriptScope(cwd: string | undefined, fallback: Scope): Promise<Scope> {
    if (!cwd) return fallback
    const cached = scopeCache.get(cwd)
    if (cached) return cached
    try {
      const stat = await fs.stat(cwd)
      if (!stat.isDirectory()) return fallback
    } catch {
      // The original working directory no longer exists on this machine.
      return fallback
    }
    const { scope } = await Scope.fromDirectory(cwd)
    scopeCache.set(cwd, scope)
    return scope
  }

  /**
   * Decode the original working directory from a Claude Code transcript
   * path: `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`. Returns
   * undefined for custom directory layouts that are not URL-encoded paths.
   */
  export function claudeCodeCwdFromFile(file: string): string | undefined {
    return decodeProjectDir(path.basename(path.dirname(file)))
  }

  /**
   * Import a single transcript from its raw text, into the scope that owns
   * the transcript's original working directory (creating it when needed),
   * or the current scope when that directory is unavailable. When the write
   * path fails, every session that was created for this file is removed
   * again so a failed import leaves no partial data behind.
   */
  export async function importText(
    source: Source,
    text: string,
    options: Pick<ImportFileOptions, "includeSidechains" | "includeThinking"> & { cwd?: string } = {},
  ): Promise<ImportFileResult> {
    const { report, stats } = parseTranscript(source, text, options)
    const sessionData = report.sessions[0]
    if (!sessionData || sessionData.messages.length === 0) {
      throw new Error("No importable messages found in transcript")
    }
    const created: Array<{ sourceSessionID: string; sessionID: string }> = []
    try {
      const fallback = ScopeContext.current.scope
      const reportCwd = sessionData.info.scope.directory || options.cwd
      const scope = await resolveTranscriptScope(reportCwd, fallback)
      const result = await ScopeContext.provide({
        scope,
        fn: () =>
          SessionImport.fromReport(report, {
            onSessionCreated: (sourceSessionID, sessionID) => created.push({ sourceSessionID, sessionID }),
          }),
      })
      return { result, stats }
    } catch (error) {
      await rollbackCreatedSessions(created)
      throw error
    }
  }

  /** Read and import a single transcript file with rollback on failure. */
  export async function importFile(file: string, options: ImportFileOptions): Promise<ImportFileResult> {
    const text = await Bun.file(file).text()
    return importText(options.source, text, {
      includeSidechains: options.includeSidechains,
      includeThinking: options.includeThinking,
      cwd: options.source === "claude-code" ? claudeCodeCwdFromFile(file) : undefined,
    })
  }

  async function rollbackCreatedSessions(
    created: Array<{ sourceSessionID: string; sessionID: string }>,
  ): Promise<void> {
    for (const { sessionID } of created.reverse()) {
      try {
        await Session.remove(sessionID)
      } catch (error) {
        log.warn("failed to roll back partially imported session", { sessionID, error })
      }
    }
  }

  // ── Batch job ──────────────────────────────────────────────────────────

  export interface StartJobInput {
    source: Source
    paths: string[]
    includeSidechains?: boolean
    includeThinking?: boolean
  }

  function summary(state: JobState): JobSummary {
    const { items: _, ...rest } = state
    return rest
  }

  /** Start a server-owned batch import job. Throws when a job is running. */
  export function start(input: StartJobInput): JobSummary {
    const current = currentSummary()
    if (current?.status === "running") {
      throw new Error("A foreign session import job is already running")
    }
    const id = randomUUID()
    const state: JobState = {
      id,
      source: input.source,
      status: "running",
      totalCount: input.paths.length,
      completedCount: 0,
      okCount: 0,
      failedCount: 0,
      startedAt: Date.now(),
      completedAt: null,
      error: null,
      items: input.paths.map((p) => ({ path: p, status: "pending" as const })),
    }
    jobs.set(id, state)
    if (input.paths.length === 0) {
      state.status = "completed"
      state.completedAt = Date.now()
      return summary(state)
    }
    const controller = new AbortController()
    controllers.set(id, controller)
    const promise = run(id, input, controller.signal)
    running.set(id, promise)
    return summary(state)
  }

  async function run(id: string, input: StartJobInput, signal: AbortSignal): Promise<void> {
    const state = jobs.get(id)!
    try {
      for (const item of state.items) {
        if (signal.aborted) {
          state.status = "cancelled"
          break
        }
        item.status = "running"
        try {
          const { result } = await importFile(item.path, {
            source: input.source,
            includeSidechains: input.includeSidechains,
            includeThinking: input.includeThinking,
          })
          item.status = "ok"
          item.sessionID = result.rootSessionID
          item.title = result.sessions[0]?.session.title
          state.okCount++
        } catch (error) {
          item.status = "failed"
          item.error = error instanceof Error ? error.message : String(error)
          state.failedCount++
        }
        state.completedCount++
      }
      if (state.status !== "cancelled") state.status = "completed"
    } catch (error) {
      state.status = "failed"
      state.error = error instanceof Error ? error.message : String(error)
    } finally {
      state.completedAt = Date.now()
      controllers.delete(id)
      running.delete(id)
    }
  }

  export function getJob(id: string): JobState | undefined {
    return jobs.get(id)
  }

  export function current(): JobState | undefined {
    let latest: JobState | undefined
    for (const job of jobs.values()) {
      if (!latest || job.startedAt > latest.startedAt) latest = job
    }
    return latest
  }

  export function currentSummary(): JobSummary | undefined {
    const job = current()
    return job ? summary(job) : undefined
  }

  export async function cancel(id: string): Promise<JobSummary> {
    const state = jobs.get(id)
    if (!state) throw new Error(`Foreign import job not found: ${id}`)
    if (state.status !== "running") throw new Error(`Foreign import job is not running: ${id}`)
    controllers.get(id)?.abort()
    try {
      await running.get(id)
    } finally {
      // status was set by run(); nothing else to clean up
    }
    return summary(state)
  }
}
