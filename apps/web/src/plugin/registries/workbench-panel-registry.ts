import type { Component, JSX } from "solid-js"
import { SlotRegistry, compareSlotEntries, type SlotEntryBase, type SurfaceEntry } from "../slot-registry"

export type WorkbenchPanelSurface = "side" | "bottom"
export type WorkbenchPanelCardinality = "exclusive" | "singleton" | "multi"

export interface WorkbenchPanelTab {
  id: string
  panelId: string
  resourceId?: string
  title?: string
  source?: string
  state?: unknown
  dirty?: boolean
}

export interface WorkbenchPanelContentProps {
  pluginId: string
  panelId: string
  tab: WorkbenchPanelTab
  onRequestClose?: () => void
  active?: () => boolean
}

export interface WorkbenchPanelTabInit {
  id?: string
  resourceId?: string
  title?: string
  source?: string
  state?: unknown
  dirty?: boolean
}

export interface WorkbenchPanelOpenContext {
  requestId: string
  onCancel(handler: () => void | Promise<void>): void | Promise<void>
}

export interface WorkbenchPanelOpening {
  phase: "preparing" | "error"
  error?: unknown
  resolve(): Promise<WorkbenchPanelTab>
  retry(): Promise<WorkbenchPanelTab | undefined>
}

export interface WorkbenchPanelEntry extends SurfaceEntry {
  moduleKey?: object
  generation?: string
  retention?: "pause"
  surface: WorkbenchPanelSurface
  cardinality: WorkbenchPanelCardinality
  requiresSession?: boolean
  supportsDraftSession?: boolean
  launchable?: boolean
  component?: Component<WorkbenchPanelContentProps>
  openingComponent?: Component<WorkbenchPanelContentProps>
  loader?: () => Promise<{ default: Component<WorkbenchPanelContentProps> }>
  exportName?: string
  defaultResource?: WorkbenchPanelTabInit
  createTab?: (
    init?: WorkbenchPanelTabInit,
    context?: WorkbenchPanelOpenContext,
  ) => WorkbenchPanelTabInit | void | Promise<WorkbenchPanelTabInit | void>
  resolveTab?: (
    init: WorkbenchPanelTabInit,
    context?: WorkbenchPanelOpenContext,
  ) => WorkbenchPanelTabInit | undefined | Promise<WorkbenchPanelTabInit | undefined>
  restoreTab?: (
    context?: WorkbenchPanelOpenContext,
  ) => WorkbenchPanelTabInit | void | Promise<WorkbenchPanelTabInit | void>
  beforeCloseTab?: (tab: WorkbenchPanelTab) => boolean | Promise<boolean>
  onCloseTab?: (tab: WorkbenchPanelTab) => void | boolean | Promise<void | boolean>
  title?: (tab: WorkbenchPanelTab, siblingTabs: WorkbenchPanelTab[]) => string | undefined
  tabActions?: (
    tab: WorkbenchPanelTab,
  ) => Array<{ id: string; label: string; disabled?: boolean; run(): void | Promise<void> }>
  tabIcon?: (tab: WorkbenchPanelTab) => JSX.Element
}

/** Internal slot-backed entry: workbench panels live in one slot. */
type WorkbenchSlotEntry = SlotEntryBase &
  WorkbenchPanelEntry & {
    slot: "workbench.panel"
  }

const registry = new SlotRegistry<WorkbenchSlotEntry>()
let activeNative: SlotRegistry<WorkbenchSlotEntry> | undefined
const activationListeners = new Set<() => void>()
const notifyActivation = () => {
  for (const listener of activationListeners) listener()
}

/** Strip the internal slot key so callers see the exact public entry shape. */
function toEntry(entry: WorkbenchSlotEntry): WorkbenchPanelEntry {
  const { slot: _slot, ...rest } = entry
  return rest
}

export function registerWorkbenchPanel(entry: WorkbenchPanelEntry): () => void {
  return registry.register({ ...entry, moduleKey: entry.moduleKey ?? {}, slot: "workbench.panel" })
}

export function listWorkbenchPanels(surface?: WorkbenchPanelSurface): WorkbenchPanelEntry[] {
  return listPanels(activeNative, surface)
}

export function getWorkbenchPanel(id: string): WorkbenchPanelEntry | undefined {
  const entry = activeNative?.get(id) ?? registry.get(id)
  return entry ? toEntry(entry) : undefined
}

export function clearWorkbenchPanels(pluginId?: string): void {
  registry.clear(pluginId)
}

export function subscribeWorkbenchPanels(listener: () => void): () => void {
  const off = registry.subscribe(listener)
  activationListeners.add(listener)
  return () => {
    off()
    activationListeners.delete(listener)
  }
}

function listPanels(native?: SlotRegistry<WorkbenchSlotEntry>, surface?: WorkbenchPanelSurface) {
  const entries = new Map(registry.listAll().map((entry) => [entry.id, entry]))
  for (const entry of native?.listAll() ?? []) entries.set(entry.id, entry)
  return [...entries.values()]
    .sort(compareSlotEntries)
    .filter((entry) => !surface || entry.surface === surface)
    .map(toEntry)
}

export function createWorkbenchPanelRegistry() {
  const native = new SlotRegistry<WorkbenchSlotEntry>()
  return {
    register(entry: WorkbenchPanelEntry) {
      return native.register({ ...entry, moduleKey: entry.moduleKey ?? {}, slot: "workbench.panel" })
    },
    get(id: string) {
      const entry = native.get(id) ?? registry.get(id)
      return entry && toEntry(entry)
    },
    list: (surface?: WorkbenchPanelSurface) => listPanels(native, surface),
    subscribe(listener: () => void) {
      const local = native.subscribe(listener),
        global = registry.subscribe(listener)
      return () => {
        local()
        global()
      }
    },
    activate() {
      activeNative = native
      const off = native.subscribe(() => {
        if (activeNative === native) notifyActivation()
      })
      notifyActivation()
      return () => {
        off()
        if (activeNative !== native) return
        activeNative = undefined
        notifyActivation()
      }
    },
  }
}
