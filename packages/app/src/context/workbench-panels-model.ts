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

export function openWorkbenchPanelTab(input: OpenWorkbenchPanelInput): {
  tabs: WorkbenchPanelTab[]
  active: string
  created?: WorkbenchPanelTab
} {
  const existing = input.tabs.find((tab) => tab.panelId === input.panelId)

  if (input.cardinality === "exclusive") {
    const tab = createWorkbenchTab({ panelId: input.panelId, init: input.init ?? existing, createId: input.createId })
    return { tabs: [tab], active: tab.id, created: existing ? undefined : tab }
  }

  if (input.cardinality === "singleton" || input.reuseExisting) {
    if (existing) return { tabs: input.tabs, active: existing.id }
    const tab = createWorkbenchTab({ panelId: input.panelId, init: input.init, createId: input.createId })
    return { tabs: [...input.tabs, tab], active: tab.id, created: tab }
  }

  const tab = createWorkbenchTab({ panelId: input.panelId, init: input.init, createId: input.createId })
  return { tabs: [...input.tabs, tab], active: tab.id, created: tab }
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
