import { createSignal } from "solid-js"
import type { Component } from "solid-js"
import type { AttachmentPart } from "@ericsanchezok/synergy-sdk"
import type { ToolTimeoutMetadata } from "@ericsanchezok/synergy-util/tool-timeout"

// Index signature is preserved so plugin-authored renderers keep reading their
// own metadata keys; `toolTimeout` is the one entry with a shared shape.
export type ToolMetadata = Record<string, any> & { toolTimeout?: ToolTimeoutMetadata }

// ── Tool component type ──────────────────────────────────────

export interface ToolProps {
  input: Record<string, any>
  metadata: ToolMetadata
  tool: string
  title?: string
  output?: string
  status?: string
  raw?: string
  charsReceived?: number
  time?: { start?: number; end?: number; compacted?: number }
  hideDetails?: boolean
  defaultOpen?: boolean
  forceOpen?: boolean
  sessionId?: string
  partId?: string
  messageId?: string
  attachments?: AttachmentPart[]
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
export function resolveExternalToolRenderer(
  toolName: string,
  externals: {
    externalLookup?: (name: string) => ToolComponent | undefined
    externalLoadNotify?: () => number
  },
): ToolComponent | undefined {
  if (!externals.externalLookup) return undefined
  externals.externalLoadNotify?.()
  return externals.externalLookup(toolName)
}

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
  return resolveExternalToolRenderer(toolName, externals)
}
