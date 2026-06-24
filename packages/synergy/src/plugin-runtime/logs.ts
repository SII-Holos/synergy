// ── Plugin log entry types ──────────────────────────────────────────

export interface PluginLogEntry {
  timestamp: number
  level: string
  message: string
}

// ── Plugin log buffer ──────────────────────────────────────────────

import { LogRateLimiter } from "./resource-limits.js"

/**
 * Fixed-capacity, per-plugin ring buffer for plugin log entries.
 *
 * - Each plugin gets its own FIFO buffer with a configurable maximum
 *   number of entries.
 * - When a plugin exceeds its cap the oldest entry is evicted and a
 *   per-plugin drop counter is incremented.
 * - An optional {@link LogRateLimiter} can gate writes; when the
 *   limiter denies a write the entry is silently dropped (the drop
 *   counter is *not* incremented for rate-limit drops).
 */
export class PluginLogBuffer {
  private buffers = new Map<string, { entries: PluginLogEntry[]; dropped: number }>()
  private maxEntries: number
  private rateLimiter: LogRateLimiter | null

  constructor(maxEntries = 1000, rateLimiter?: LogRateLimiter) {
    this.maxEntries = maxEntries
    this.rateLimiter = rateLimiter ?? null
  }

  /**
   * Append a log entry for `pluginId`.
   *
   * Returns `true` when the entry was stored, `false` when it was
   * rejected by the rate limiter or the buffer has a zero cap.
   */
  append(pluginId: string, entry: PluginLogEntry): boolean {
    // Rate-limit check (before allocating storage)
    if (this.rateLimiter) {
      const estimatedBytes = JSON.stringify(entry).length
      if (!this.rateLimiter.allow(estimatedBytes)) {
        return false
      }
    }

    let buf = this.buffers.get(pluginId)
    if (!buf) {
      buf = { entries: [], dropped: 0 }
      this.buffers.set(pluginId, buf)
    }

    if (this.maxEntries === 0) {
      buf.dropped++
      return false
    }

    if (buf.entries.length >= this.maxEntries) {
      buf.entries.shift()
      buf.dropped++
    }

    buf.entries.push(entry)
    return true
  }

  /**
   * Return a shallow copy of the log entries for `pluginId`, in
   * insertion order (oldest first).
   */
  list(pluginId: string): PluginLogEntry[] {
    const buf = this.buffers.get(pluginId)
    if (!buf) return []
    return [...buf.entries]
  }

  /**
   * Remove all entries and reset the drop counter for `pluginId`.
   */
  clear(pluginId: string): void {
    const buf = this.buffers.get(pluginId)
    if (buf) {
      buf.entries.length = 0
      buf.dropped = 0
    }
  }

  /**
   * Number of entries evicted because the per-plugin max was exceeded.
   */
  droppedCount(pluginId: string): number {
    const buf = this.buffers.get(pluginId)
    return buf ? buf.dropped : 0
  }

  /**
   * Total number of entries currently stored across all plugins.
   */
  entryCount(): number {
    let total = 0
    for (const buf of this.buffers.values()) {
      total += buf.entries.length
    }
    return total
  }
}
