/**
 * Plugin Platform v2 — Frontend UI Types
 * @packageDocumentation
 */

import type { Component } from "solid-js"

// ──── Core Context ────

/** Context passed to all plugin UI components via usePluginHost() */
export interface PluginUIContext {
  /** The plugin's unique ID */
  pluginId: string
  /** Synergy server base URL */
  serverUrl: string
  /** Current UI API version reported by the host */
  UIApiVersion: string
  /** Current theme mode */
  theme: "light" | "dark"
  /** Current session ID, if in session context */
  sessionId: string | null
  /** Current scope info */
  scope: { type: "global" | "project"; id: string; directory: string } | null
}

// ──── Tool Renderer ────

/** Props received by plugin tool card renderers */
export interface PluginToolRendererProps {
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

export type PluginToolRenderer = Component<PluginToolRendererProps>

// ──── Part Renderer ────

export interface PluginPartRendererProps {
  part: Record<string, unknown>
  message: Record<string, unknown>
}

export type PluginPartRenderer = Component<PluginPartRendererProps>

// ──── Panel ────

export interface PluginPanelProps {
  pluginId: string
  panelId: string
  scope?: { type: "global" | "project"; id: string; directory: string }
  sessionId?: string
}

export type PluginPanelComponent = Component<PluginPanelProps>

// ──── Settings ────

export interface PluginSettingsPanelProps {
  pluginId: string
  config: Record<string, unknown>
  /** Call with updated values; host deep-merges and persists */
  onConfigChange: (values: Record<string, unknown>) => Promise<void>
}

export type PluginSettingsPanelComponent = Component<PluginSettingsPanelProps>

// ──── Chat Component ────

export interface PluginChatComponentProps {
  pluginId: string
  message: Record<string, unknown>
  parts: Record<string, unknown>[]
  sessionId: string
}

export type PluginChatComponent = Component<PluginChatComponentProps>

// ──── UIApiVersion ────

/** Current UI API version — bump on breaking changes to any Plugin UI type */
export const CURRENT_UI_API_VERSION = "2.0.0"
