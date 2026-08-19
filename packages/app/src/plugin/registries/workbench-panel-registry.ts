import type { Component, JSX } from "solid-js"
import { SlotRegistry, type SlotEntryBase, type SurfaceEntry } from "../slot-registry"

export type WorkbenchPanelSurface = "side" | "bottom"
export type WorkbenchPanelCardinality = "exclusive" | "singleton" | "multi"

export interface WorkbenchPanelTab {
  id: string
  panelId: string
  resourceId?: string
  title?: string
  source?: string
  state?: unknown
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
  state?: unknown
}

export interface WorkbenchPanelEntry extends SurfaceEntry {
  surface: WorkbenchPanelSurface
  cardinality: WorkbenchPanelCardinality
  requiresSession?: boolean
  supportsDraftSession?: boolean
  launchable?: boolean
  component?: Component<WorkbenchPanelContentProps>
  loader?: () => Promise<{ default: Component<WorkbenchPanelContentProps> }>
  exportName?: string
  defaultResource?: WorkbenchPanelTabInit
  createTab?: () => WorkbenchPanelTabInit | void | Promise<WorkbenchPanelTabInit | void>
  onCloseTab?: (tab: WorkbenchPanelTab) => void | Promise<void>
  title?: (tab: WorkbenchPanelTab, siblingTabs: WorkbenchPanelTab[]) => string | undefined
  tabIcon?: (tab: WorkbenchPanelTab) => JSX.Element
}

/** Internal slot-backed entry: workbench panels live in one slot. */
type WorkbenchSlotEntry = SlotEntryBase &
  WorkbenchPanelEntry & {
    slot: "workbench.panel"
  }

const registry = new SlotRegistry<WorkbenchSlotEntry>()

/** Strip the internal slot key so callers see the exact public entry shape. */
function toEntry(entry: WorkbenchSlotEntry): WorkbenchPanelEntry {
  const { slot: _slot, ...rest } = entry
  return rest
}

export function registerWorkbenchPanel(entry: WorkbenchPanelEntry): () => void {
  return registry.register({ ...entry, slot: "workbench.panel" })
}

export function listWorkbenchPanels(surface?: WorkbenchPanelSurface): WorkbenchPanelEntry[] {
  if (surface) return registry.listAll((e) => e.surface === surface).map(toEntry)
  return registry.listAll().map(toEntry)
}

export function getWorkbenchPanel(id: string): WorkbenchPanelEntry | undefined {
  const entry = registry.get(id)
  return entry ? toEntry(entry) : undefined
}

export function clearWorkbenchPanels(pluginId?: string): void {
  registry.clear(pluginId)
}

export function subscribeWorkbenchPanels(listener: () => void): () => void {
  return registry.subscribe(listener)
}
