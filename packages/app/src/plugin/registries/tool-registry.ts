import type { Component } from "solid-js"
import { createSignal, createRoot, createEffect } from "solid-js"
import { ToolRegistry } from "@ericsanchezok/synergy-ui/message-part"

export interface ToolFallbackMeta {
  icon?: string
  title?: string
  subtitleTemplate?: string
}

export interface ToolRendererProps {
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  tool: string
  title?: string
  output?: string
  status?: string
  raw?: string
  charsReceived?: number
  hideDetails?: boolean
  defaultOpen?: boolean
  forceOpen?: boolean
}

export type ToolRenderer = Component<ToolRendererProps>

/** A single tool renderer entry in the registry. */
export interface ToolRendererEntry {
  renderer?: ToolRenderer
  loader?: () => Promise<{ default: ToolRenderer }>
  loading?: boolean
  error?: Error
  fallback?: ToolFallbackMeta
}

// ── Signal for lazy-load re-render notification ──────────────────────────────

const [loadedSignal, setLoadedSignal] = createSignal(0)

// ── ToolRendererRegistry (class-based API) ────────────────────────────────────

/**
 * Registry of plugin-contributed tool renderers with lazy-load support.
 *
 * Resolution is always synchronous — never blocks rendering.
 * When a renderer has a loader but hasn't loaded yet, resolve() returns undefined
 * and the loader is kicked off in the background. A signal notifies subscribers
 * when any loader completes.
 */
export class ToolRendererRegistry {
  private entries = new Map<string, ToolRendererEntry>()

  /** Register a tool renderer entry. Returns a disposer function. */
  register(
    toolId: string,
    entry: {
      renderer?: ToolRenderer
      loader?: () => Promise<{ default: ToolRenderer }>
      fallback?: ToolFallbackMeta
    },
  ): () => void {
    this.entries.set(toolId, {
      renderer: entry.renderer,
      loader: entry.loader,
      loading: false,
      fallback: entry.fallback,
    })
    return () => {
      this.entries.delete(toolId)
    }
  }

  /**
   * Resolve a renderer entry synchronously.
   *
   * Returns the entry if a renderer is loaded; returns undefined otherwise.
   * If the entry has a loader but no renderer, the loader is kicked off in the
   * background and the signal is bumped on completion.
   */
  resolve(toolId: string): ToolRendererEntry | undefined {
    const entry = this.entries.get(toolId)
    if (!entry) return undefined
    if (entry.renderer) return entry
    if (entry.loader && !entry.loading) {
      entry.loading = true
      entry
        .loader()
        .then((mod) => {
          entry.renderer = mod.default
          entry.loading = false
          setLoadedSignal(Date.now())
        })
        .catch((err) => {
          entry.error = err as Error
          entry.loading = false
          setLoadedSignal(Date.now())
        })
    }
    return undefined
  }

  /**
   * Resolve just the renderer component (used by the bridge to integrate
   * with the built-in ToolRegistry fallback chain).
   */
  render(toolId: string): ToolRenderer | undefined {
    const entry = this.resolve(toolId)
    if (entry?.renderer) return entry.renderer
    // Fall back to the UI-level ToolRegistry for built-in tools
    return ToolRegistry.render(toolId)
  }

  /** Subscribe to lazy-load completions. Returns disposer. */
  onLoad(callback: () => void): () => void {
    return createRoot((dispose) => {
      createEffect(() => {
        loadedSignal()
        callback()
      })
      return dispose
    })
  }

  /** Check if a tool has a registered entry (with renderer or loader). */
  has(toolId: string): boolean {
    const entry = this.entries.get(toolId)
    return !!(entry?.renderer || entry?.loader)
  }

  /** Get fallback metadata for a tool. */
  fallback(toolId: string): ToolFallbackMeta | undefined {
    return this.entries.get(toolId)?.fallback
  }

  /** Remove all registered entries. */
  clear(): void {
    this.entries.clear()
  }
}

// ── Singleton instance ───────────────────────────────────────────────────────

export const toolRendererRegistry = new ToolRendererRegistry()
