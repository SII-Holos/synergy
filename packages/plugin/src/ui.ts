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

export interface PluginNavigationProps {
  pluginId: string
  navigationId: string
  placement: "sidebar" | "page"
  scopeId?: string
}

export interface PluginWorkbenchPanelTab {
  id: string
  panelId: string
  resourceId?: string
  title?: string
  source?: string
}

export interface PluginWorkbenchPanelProps {
  pluginId: string
  panelId: string
  tab: PluginWorkbenchPanelTab
  onRequestClose?: () => void
}

export type PluginNavigation = Component<PluginNavigationProps>
export type PluginWorkbenchPanel = Component<PluginWorkbenchPanelProps>

export interface PluginSettingsProps {
  pluginId: string
  values: Record<string, unknown>
  onChange(values: Record<string, unknown>): void
}

export type PluginSettingsSection = Component<PluginSettingsProps>

export type PluginMessageSlotName = string

export interface PluginMessageSlotProps {
  slot: PluginMessageSlotName
  sessionId?: string
  messageId?: string
  message?: unknown
}

export type PluginMessageSlot = Component<PluginMessageSlotProps>

export type PluginComposerSlotName =
  | "composer.above"
  | "composer.below"
  | "composer.toolbar.left"
  | "composer.toolbar.right"
  | "composer.add-menu"
  | "composer.start-option"

export interface PluginComposerSlotProps {
  slot: PluginComposerSlotName
  sessionId?: string
}

export type PluginComposerSlot = Component<PluginComposerSlotProps>

export interface PluginCommandContext {
  pluginId: string
  serverUrl: string
}

export type PluginUICommand = (context: PluginCommandContext) => void | Promise<void>
