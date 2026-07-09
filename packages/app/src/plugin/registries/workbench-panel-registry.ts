import type { Component } from "solid-js"
import { SurfaceRegistry } from "@/surface/registry"
import type { SurfaceEntry } from "@/surface/types"

export type WorkbenchPanelSurface = "side" | "bottom"
export type WorkbenchPanelCardinality = "exclusive" | "singleton" | "multi"

export interface WorkbenchPanelTab {
  id: string
  panelId: string
  resourceId?: string
  title?: string
  source?: string
}

export interface WorkbenchPanelContentProps {
  pluginId: string
  panelId: string
  tab: WorkbenchPanelTab
  onRequestClose?: () => void
}

export interface WorkbenchPanelTabInit {
  id?: string
  resourceId?: string
  title?: string
  source?: string
}

export interface WorkbenchPanelEntry extends SurfaceEntry {
  surface: WorkbenchPanelSurface
  cardinality: WorkbenchPanelCardinality
  requiresSession?: boolean
  component?: Component<WorkbenchPanelContentProps>
  loader?: () => Promise<{ default: Component<WorkbenchPanelContentProps> }>
  exportName?: string
  createTab?: () => WorkbenchPanelTabInit | void | Promise<WorkbenchPanelTabInit | void>
  onCloseTab?: (tab: WorkbenchPanelTab) => void | Promise<void>
  title?: (tab: WorkbenchPanelTab) => string | undefined
}

const registry = new SurfaceRegistry<WorkbenchPanelEntry>()

export function registerWorkbenchPanel(entry: WorkbenchPanelEntry): () => void {
  return registry.register(entry)
}

export function listWorkbenchPanels(surface?: WorkbenchPanelSurface): WorkbenchPanelEntry[] {
  if (surface) return registry.list((e) => e.surface === surface)
  return registry.list()
}

export function getWorkbenchPanel(id: string): WorkbenchPanelEntry | undefined {
  return registry.get(id)
}

export function clearWorkbenchPanels(pluginId?: string): void {
  registry.clear(pluginId)
}

export function subscribeWorkbenchPanels(listener: () => void): () => void {
  return registry.subscribe(listener)
}
