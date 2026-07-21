import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@/global"
import { Installation } from "@/global/installation"
import { ObservabilityEvents } from "@/observability/events"
import { ObservabilityMetrics } from "@/observability/metrics"
import type { SessionMemoryPressure } from "./memory-pressure"

export namespace SessionMemoryProfile {
  const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000
  const DEFAULT_RETAIN = 3
  const PREFIX = "heap-"
  const SUFFIX = ".heapsnapshot"

  type CaptureResult = { bytes: number }
  let lastCaptureAt = 0
  let capturing = false
  let captureForTest: ((reason: string) => Promise<CaptureResult>) | undefined

  export async function maybeCapture(input: {
    reason: string
    snapshot: SessionMemoryPressure.Snapshot
    soft: boolean
    development?: boolean
    now?: number
  }): Promise<
    | { action: "disabled" | "below_threshold" | "skipped_cooldown" | "already_capturing" }
    | { action: "captured"; bytes: number }
    | { action: "failed"; error: string }
  > {
    const development =
      input.development ?? (Installation.isLocal() || process.env.SYNERGY_MEMORY_PROFILE_ENABLED === "1")
    if (!development) return { action: "disabled" }
    if (!input.soft) return { action: "below_threshold" }
    if (capturing) return { action: "already_capturing" }
    const now = input.now ?? Date.now()
    const cooldownMs = envPositive("SYNERGY_MEMORY_PROFILE_COOLDOWN_MS") ?? DEFAULT_COOLDOWN_MS
    if (lastCaptureAt > 0 && now - lastCaptureAt < cooldownMs) return { action: "skipped_cooldown" }

    capturing = true
    lastCaptureAt = now
    try {
      const result = await (captureForTest ?? capture)(input.reason)
      ObservabilityMetrics.record({
        name: "process.memory.heap_profile.bytes",
        value: result.bytes,
        unit: "bytes",
        module: "process",
        source: "process",
        labels: { reason: input.reason },
      })
      await ObservabilityEvents.emit("process.memory.heap_profile.captured", {
        module: "process",
        source: "process",
        data: { reason: input.reason, bytes: result.bytes, memory: input.snapshot },
      })
      return { action: "captured", bytes: result.bytes }
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "Error"
      await ObservabilityEvents.emit("process.memory.heap_profile.failed", {
        module: "process",
        source: "process",
        level: "warn",
        data: { reason: input.reason, errorName },
      })
      return { action: "failed", error: errorName }
    } finally {
      capturing = false
    }
  }

  export function setCaptureForTest(value: ((reason: string) => Promise<CaptureResult>) | undefined) {
    captureForTest = value
  }

  export function resetForTest() {
    lastCaptureAt = 0
    capturing = false
    captureForTest = undefined
  }

  async function capture(_reason: string): Promise<CaptureResult> {
    const directory = path.join(Global.Path.state, "observability", "heap-profiles")
    await fs.mkdir(directory, { recursive: true })
    Bun.gc(true)
    const heap = Bun.generateHeapSnapshot("v8", "arraybuffer")
    const filename = `${PREFIX}${Date.now()}${SUFFIX}`
    await Bun.write(path.join(directory, filename), heap)
    const bytes = heap.byteLength
    await retain(directory)
    return { bytes }
  }

  async function retain(directory: string) {
    const retainCount = Math.max(1, Math.floor(envPositive("SYNERGY_MEMORY_PROFILE_RETAIN") ?? DEFAULT_RETAIN))
    const entries = await fs.readdir(directory, { withFileTypes: true })
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(PREFIX) && entry.name.endsWith(SUFFIX))
      .map((entry) => entry.name)
      .sort()
    const remove = files.slice(0, Math.max(0, files.length - retainCount))
    await Promise.all(remove.map((filename) => fs.rm(path.join(directory, filename), { force: true })))
  }

  function envPositive(name: string) {
    const value = Number(process.env[name])
    return Number.isFinite(value) && value > 0 ? value : undefined
  }
}
