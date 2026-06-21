import type { Component } from "solid-js"
import { createSignal, createEffect } from "solid-js"
import { ToolRegistry } from "@ericsanchezok/synergy-ui/message-part"

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

interface ToolEntry {
  render?: ToolRenderer
  loader?: () => Promise<{ default: ToolRenderer }>
  loading?: boolean
  error?: Error
}

const state: Record<string, ToolEntry> = {}

// Signal to notify when a lazy-loaded renderer becomes available.
// Consumers (e.g. message-part.tsx) track this signal to re-evaluate
// available renderers after async imports complete.
const [loadedSignal, setLoadedSignal] = createSignal(0)
export function onToolLoaded(cb: () => void) {
  createEffect(() => {
    loadedSignal()
    cb()
  })
}

export function registerToolRenderer(input: {
  name: string
  render?: ToolRenderer
  loader?: () => Promise<{ default: ToolRenderer }>
}): () => void {
  state[input.name] = {
    render: input.render,
    loader: input.loader,
    loading: false,
  }
  return () => {
    delete state[input.name]
  }
}

export function getToolRenderer(name: string): ToolRenderer | undefined {
  const entry = state[name]
  if (entry?.render) return entry.render
  if (entry?.loader && !entry.loading) {
    entry.loading = true
    entry
      .loader()
      .then((mod) => {
        entry.render = mod.default
        setLoadedSignal((v) => v + 1)
      })
      .catch((err) => {
        entry.error = err as Error
        setLoadedSignal((v) => v + 1)
      })
  }
  // Fall back to the UI-level ToolRegistry for built-in tools
  return ToolRegistry.render(name)
}

export function hasToolRenderer(name: string): boolean {
  return !!(state[name]?.render || state[name]?.loader)
}

export function clearAllToolRenderers(): void {
  for (const key of Object.keys(state)) {
    delete state[key]
  }
}
