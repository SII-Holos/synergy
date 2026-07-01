import type { Component } from "solid-js"

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

export interface PluginPartRendererProps {
  part: unknown
  message?: unknown
}

export type PluginPartRenderer = Component<PluginPartRendererProps>

export interface PluginPanelProps {
  pluginId: string
  panelId: string
  scopeId?: string
}

export interface PluginWorkbenchPanelTab {
  id: string
  panelId: string
  resourceId?: string
  title?: string
  source?: string
}

export interface PluginWorkbenchPanelProps extends PluginPanelProps {
  tab: PluginWorkbenchPanelTab
  onRequestClose?: () => void
}

export type PluginWorkbenchPanel = Component<PluginWorkbenchPanelProps>
export type PluginGlobalPanel = Component<PluginPanelProps>

export interface PluginSettingsProps {
  pluginId: string
  values: Record<string, unknown>
  onChange(values: Record<string, unknown>): void
}

export type PluginSettingsSection = Component<PluginSettingsProps>

export type PluginChatSlot = "before-tools" | "after-tools" | "before-reasoning" | "after-reasoning"

export interface PluginChatComponentProps {
  slot: PluginChatSlot
  sessionId?: string
  messageId?: string
}

export type PluginChatComponent = Component<PluginChatComponentProps>

export interface PluginCommandContext {
  pluginId: string
  serverUrl: string
}

export type PluginUICommand = (context: PluginCommandContext) => void | Promise<void>
