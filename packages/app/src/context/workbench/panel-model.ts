import type {
  WorkbenchPanelCardinality,
  WorkbenchPanelTab,
  WorkbenchPanelTabInit,
} from "@/plugin/registries/workbench-panel-registry"

export interface WorkbenchSurfaceState {
  opened?: boolean
  active?: string
  tabs?: WorkbenchPanelTab[]
  size?: number
  resized?: boolean
}

export interface OpenWorkbenchPanelInput {
  panelId: string
  cardinality: WorkbenchPanelCardinality
  tabs: WorkbenchPanelTab[]
  init?: WorkbenchPanelTabInit
  createId: () => string
  reuseExisting?: boolean
}

export function createWorkbenchTab(input: {
  panelId: string
  init?: WorkbenchPanelTabInit
  createId: () => string
}): WorkbenchPanelTab {
  return {
    id: input.init?.id ?? input.createId(),
    panelId: input.panelId,
    resourceId: input.init?.resourceId,
    title: input.init?.title,
    source: input.init?.source,
  }
}

function updateWorkbenchTab(tab: WorkbenchPanelTab, init?: WorkbenchPanelTabInit): WorkbenchPanelTab {
  if (!init) return tab

  const next: WorkbenchPanelTab = { ...tab }
  let changed = false

  if (init.resourceId !== undefined && init.resourceId !== tab.resourceId) {
    next.resourceId = init.resourceId
    changed = true
  }
  if (init.title !== undefined && init.title !== tab.title) {
    next.title = init.title
    changed = true
  }
  if (init.source !== undefined && init.source !== tab.source) {
    next.source = init.source
    changed = true
  }

  return changed ? next : tab
}

export function openWorkbenchPanelTab(input: OpenWorkbenchPanelInput): {
  tabs: WorkbenchPanelTab[]
  active: string
  created?: WorkbenchPanelTab
} {
  const resource = input.init?.resourceId
  const resourceMatch =
    resource === undefined
      ? undefined
      : input.tabs.find((tab) => tab.panelId === input.panelId && tab.resourceId === resource)
  const panelMatch = input.tabs.find((tab) => tab.panelId === input.panelId)
  const existing = resourceMatch ?? panelMatch

  if (input.cardinality === "exclusive") {
    const tab = createWorkbenchTab({ panelId: input.panelId, init: input.init ?? existing, createId: input.createId })
    return { tabs: [tab], active: tab.id, created: existing ? undefined : tab }
  }

  if (resourceMatch || input.cardinality === "singleton" || input.reuseExisting) {
    if (existing) {
      const updated = updateWorkbenchTab(existing, input.init)
      if (updated === existing) return { tabs: input.tabs, active: existing.id }
      return {
        tabs: input.tabs.map((tab) => (tab.id === existing.id ? updated : tab)),
        active: updated.id,
      }
    }
    const tab = createWorkbenchTab({ panelId: input.panelId, init: input.init, createId: input.createId })
    return { tabs: [...input.tabs, tab], active: tab.id, created: tab }
  }

  const tab = createWorkbenchTab({ panelId: input.panelId, init: input.init, createId: input.createId })
  return { tabs: [...input.tabs, tab], active: tab.id, created: tab }
}

export function updateWorkbenchPanelTab(
  tabs: WorkbenchPanelTab[],
  tabId: string,
  patch: Omit<WorkbenchPanelTabInit, "id">,
): WorkbenchPanelTab[] {
  const index = tabs.findIndex((tab) => tab.id === tabId)
  if (index === -1) return tabs
  const updated = updateWorkbenchTab(tabs[index]!, patch)
  if (updated === tabs[index]) return tabs
  return tabs.map((tab) => (tab.id === tabId ? updated : tab))
}

export function moveWorkbenchPanelTab(tabs: WorkbenchPanelTab[], tabId: string, toIndex: number): WorkbenchPanelTab[] {
  const fromIndex = tabs.findIndex((tab) => tab.id === tabId)
  if (fromIndex === -1) return tabs
  const target = Math.max(0, Math.min(toIndex, tabs.length - 1))
  if (fromIndex === target) return tabs
  const next = tabs.slice()
  const [tab] = next.splice(fromIndex, 1)
  next.splice(target, 0, tab!)
  return next
}

export function closeWorkbenchPanelTab(
  tabs: WorkbenchPanelTab[],
  active: string | undefined,
  tabId: string,
): { tabs: WorkbenchPanelTab[]; active: string | undefined } {
  const index = tabs.findIndex((tab) => tab.id === tabId)
  if (index === -1) return { tabs, active }

  const next = tabs.filter((tab) => tab.id !== tabId)
  if (active !== tabId) return { tabs: next, active }

  return {
    tabs: next,
    active: next[index - 1]?.id ?? next[index]?.id,
  }
}
