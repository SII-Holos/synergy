import { createSignal } from "solid-js"
import type { Component } from "solid-js"

// ── Tool component type ──────────────────────────────────────

export interface ToolProps {
  input: Record<string, any>
  metadata: Record<string, any>
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

export type ToolComponent = Component<ToolProps>

// ── Built-in imperative registry (Tier 2) ────────────────────

const state: Record<string, { name: string; render?: ToolComponent }> = {}

export function registerTool(input: { name: string; render?: ToolComponent }) {
  state[input.name] = input
  return input
}

export function getTool(name: string) {
  return state[name]?.render
}

export const ToolRegistry = {
  register: registerTool,
  render: getTool,
}

// ── External (plugin) tool lookup extension point ─────────────
// Set by the app layer to bridge getToolRenderer from the plugin SDK.
// When a tool name misses the built-in registry, this lookup is tried.

export let externalLookup: ((name: string) => ToolComponent | undefined) | undefined
export function setExternalToolLookup(fn: (name: string) => ToolComponent | undefined) {
  externalLookup = fn
}

// External fallback metadata lookup — injected by plugin ToolRegistry bridge.
// Returns declarative icon/title/subtitleTemplate for Tier 1 tool renderers.
export let externalFallbackLookup:
  | ((name: string) =>
      | {
          icon?: string
          title?: string
          subtitleTemplate?: string
        }
      | undefined)
  | undefined
export function setExternalFallbackLookup(
  fn: (name: string) => { icon?: string; title?: string; subtitleTemplate?: string } | undefined,
) {
  externalFallbackLookup = fn
}

// Bumped by the app layer when a lazy-loaded plugin tool renderer becomes
// available, so createMemo re-evaluates and picks up the new renderer.
const [_externalLoadNotify, _setExternalLoadNotify] = createSignal(0)
export const externalLoadNotify: () => number = _externalLoadNotify
export function notifyExternalToolLoaded() {
  _setExternalLoadNotify((n) => n + 1)
}

// ── Resolution ────────────────────────────────────────────────

/**
 * Pure resolution function — testable without SolidJS reactivity context.
 *
 * Resolution order:
 *   1. Built-in ToolRegistry (Tier 2 imperative renderers)
 *   2. External plugin lookup (lazy-loaded Tier 2 renderers)
 *   3. undefined → caller falls back to SmartTool / GenericTool
 *
 * @param externalLoadNotify — accessor that forces re-evaluation on lazy-load completion
 */
export function resolveToolRenderer(
  toolName: string,
  registry: { render: (name: string) => ToolComponent | undefined },
  externals: {
    externalLookup?: (name: string) => ToolComponent | undefined
    externalLoadNotify?: () => number
  },
): ToolComponent | undefined {
  const builtin = registry.render(toolName)
  if (builtin) return builtin
  if (externals.externalLookup) {
    externals.externalLoadNotify?.() // subscribe to lazy-load completions
    return externals.externalLookup(toolName)
  }
  return undefined
}
