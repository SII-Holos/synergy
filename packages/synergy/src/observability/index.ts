import fs from "fs/promises"
import path from "path"
import { Global } from "@/global"
import { ObservabilityContext } from "./context"
import { ObservabilityEvents } from "./events"
import { ObservabilityRedaction } from "./redaction"
import { ObservabilitySchema } from "./schema"
import { ObservabilitySpans } from "./spans"
import { ObservabilityStore } from "./store"
import { ObservabilityWriter } from "./writer"

export { ObservabilityContext } from "./context"
export { ObservabilityEvents } from "./events"
export { ObservabilityIssues } from "./issues"
export { ObservabilityMetrics } from "./metrics"
export { ObservabilityToolFailures } from "./tool-failures"
export { ObservabilityRedaction } from "./redaction"
export { ObservabilityResources } from "./resources"
export { ObservabilitySchema } from "./schema"
export { ObservabilitySpans } from "./spans"
export { ObservabilityStore } from "./store"
export { ObservabilityWriter } from "./writer"

export namespace Observability {
  export type Event = ObservabilitySchema.Event
  export type Query = ObservabilitySchema.Query

  const TRACE_DIR = path.join(Global.Path.state, "observability", "traces")

  export function traceId(prefix = "trc") {
    return ObservabilitySpans.traceId(prefix)
  }

  export function dir() {
    return TRACE_DIR
  }

  export function fileForDate(date = new Date()) {
    return path.join(TRACE_DIR, `${date.toISOString().slice(0, 10)}.jsonl`)
  }

  export async function emit(
    type: string,
    input: Omit<Partial<Event>, "type" | "time" | "iso" | "eventId" | "data" | "redaction"> & {
      data?: Record<string, unknown>
    } = {},
  ) {
    const event = await ObservabilityEvents.emit(type, input)
    ObservabilityWriter.append(fileForDate(new Date(event.time)), JSON.stringify(event) + "\n")
    return event
  }

  export async function flush() {
    ObservabilityStore.flush()
    await ObservabilityWriter.flush()
  }

  export async function query(input: Query = {}) {
    await flush()
    return ObservabilityStore.queryEvents(input).map(ObservabilityEvents.fromRow)
  }

  export async function cleanup(opts?: { retentionDays?: number; maxBytes?: number }) {
    await flush()
    ObservabilityStore.retain()
    await cleanupMirrorFiles(opts).catch(() => {})
  }

  export async function listFiles() {
    const entries = await fs.readdir(TRACE_DIR).catch((): string[] => [])
    return entries
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .sort()
      .map((name) => path.join(TRACE_DIR, name))
  }

  export const sanitizeRecord = ObservabilityRedaction.record
  export const sanitizeText = ObservabilityRedaction.text

  export const withContext = ObservabilityContext.withContext
  export const withContextAsync = ObservabilityContext.withContextAsync
  export const currentContext = ObservabilityContext.current

  async function cleanupMirrorFiles(opts?: { retentionDays?: number; maxBytes?: number }) {
    const retentionDays = opts?.retentionDays ?? 7
    const maxBytes = opts?.maxBytes ?? 250 * 1024 * 1024
    const files = await listFiles()
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
    const stats = await Promise.all(
      files.map(async (file) => ({ file, stat: await fs.stat(file).catch(() => undefined) })),
    )
    for (const item of stats) {
      if (item.stat && item.stat.mtimeMs < cutoff) await fs.rm(item.file, { force: true }).catch(() => {})
    }
    const remaining = stats
      .filter((item) => item.stat && item.stat.mtimeMs >= cutoff)
      .sort((a, b) => (b.stat?.mtimeMs ?? 0) - (a.stat?.mtimeMs ?? 0))
    let total = 0
    for (const item of remaining) {
      total += item.stat?.size ?? 0
      if (total > maxBytes) await fs.rm(item.file, { force: true }).catch(() => {})
    }
  }
}
