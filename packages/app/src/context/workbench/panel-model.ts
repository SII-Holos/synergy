import type {
  WorkbenchPanelCardinality,
  WorkbenchPanelEntry,
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
  replaceEmpty?: boolean
}

export function isWorkbenchPanelAvailable(entry: WorkbenchPanelEntry, hasSession: boolean) {
  return !entry.requiresSession || hasSession || entry.supportsDraftSession === true
}

export function isWorkbenchPanelLaunchable(entry: WorkbenchPanelEntry) {
  return entry.launchable !== false
}

export type WorkbenchEscapeAction = "none" | "close-menu" | "close-surface"

export function resolveWorkbenchEscapeAction(input: {
  key: string
  opened: boolean
  menuOpen: boolean
  dialogActive: boolean
  editableFocus?: boolean
}): WorkbenchEscapeAction {
  if (input.key !== "Escape" || !input.opened || input.dialogActive) return "none"
  if (input.editableFocus) return "none"
  return input.menuOpen ? "close-menu" : "close-surface"
}

interface WorkbenchEscapeTarget {
  tagName?: string
  isContentEditable?: boolean
  closest?: (selector: string) => Element | null
}

/**
 * Whether an Escape keydown target should receive the key itself instead of
 * the workbench surface closing. Matches the session page's protected-focus
 * predicate: form controls, contentEditable regions, and elements inside a
 * `[data-prevent-autofocus]` region (terminal and browser surfaces).
 */
export function isEditableEscapeTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false
  const node = target as WorkbenchEscapeTarget
  const tagName = typeof node.tagName === "string" ? node.tagName.toUpperCase() : ""
  if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") return true
  if (node.isContentEditable === true) return true
  if (typeof node.closest === "function") {
    try {
      return Boolean(node.closest("[data-prevent-autofocus]"))
    } catch {
      return false
    }
  }
  return false
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
    state: input.init?.state,
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
  if (init.state !== undefined && init.state !== tab.state) {
    next.state = init.state
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
  const emptyMatch = input.replaceEmpty
    ? input.tabs.find((tab) => tab.panelId === input.panelId && tab.resourceId === undefined)
    : undefined
  const panelMatch = input.tabs.find((tab) => tab.panelId === input.panelId)
  const existing = resourceMatch ?? emptyMatch ?? panelMatch

  if (input.cardinality === "exclusive") {
    const tab = createWorkbenchTab({ panelId: input.panelId, init: input.init ?? existing, createId: input.createId })
    return { tabs: [tab], active: tab.id, created: existing ? undefined : tab }
  }

  if (resourceMatch || emptyMatch || input.cardinality === "singleton" || input.reuseExisting) {
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

/**
 * Compute the tab list and active tab after a "close other tabs" batch.
 *
 * Without `closingIds` the batch removes every tab but `keepTabId` and
 * activates the kept tab. When `closingIds` is supplied the removal is
 * bounded to that snapshot set instead: async close-others awaits each
 * panel's onCloseTab hook, and during that window the store may legitimately
 * gain new tabs (the user opens another file) that this batch must not
 * sweep, or lose the kept tab (its own panel reports the resource gone and
 * routes through closeTab). The kept tab is never removed even if listed.
 *
 * Active-tab fallback mirrors closeWorkbenchPanelTab: the kept tab wins when
 * it survives; otherwise an active tab that survives keeps focus, and an
 * active tab that was removed falls back to its nearest surviving neighbor.
 */
export function closeOtherWorkbenchPanelTabs(
  tabs: WorkbenchPanelTab[],
  active: string | undefined,
  keepTabId: string,
  closingIds?: ReadonlySet<string>,
): { tabs: WorkbenchPanelTab[]; active: string | undefined } {
  const keepExists = tabs.some((tab) => tab.id === keepTabId)
  if (!keepExists && !closingIds) return { tabs, active }

  const closing = new Set(closingIds ?? tabs.map((tab) => tab.id).filter((id) => id !== keepTabId))
  closing.delete(keepTabId)
  const removed = tabs.filter((tab) => closing.has(tab.id))
  if (removed.length === 0) return { tabs, active }

  const next = tabs.filter((tab) => !closing.has(tab.id))
  if (next.some((tab) => tab.id === keepTabId)) return { tabs: next, active: keepTabId }
  if (active && next.some((tab) => tab.id === active)) return { tabs: next, active }

  const anchor = tabs.findIndex((tab) => tab.id === (active ?? keepTabId))
  return { tabs: next, active: next[anchor - 1]?.id ?? next[anchor]?.id ?? next[0]?.id }
}

/**
 * Cross-instance registry of workbench-surface escape-sensitive menus.
 *
 * The side and bottom workbench surfaces each mount a capture-phase document
 * keydown listener for Escape. A listener cannot stop the other surface's
 * listener with stopPropagation (same node, same phase), so an Escape meant
 * to dismiss a context menu on one surface also collapsed the other open
 * surface. Every mounted surface registers a handle here; the keydown
 * handler then consults the registry so all instances agree on whether any
 * menu is open before falling through to close-surface.
 */
export interface WorkbenchEscapeMenuHandle {
  isAnyMenuOpen(): boolean
  closeMenus(): void
}

const escapeMenuHandles = new Set<WorkbenchEscapeMenuHandle>()

export function registerWorkbenchEscapeMenu(handle: WorkbenchEscapeMenuHandle): () => void {
  escapeMenuHandles.add(handle)
  return () => {
    escapeMenuHandles.delete(handle)
  }
}

export function anyWorkbenchEscapeMenuOpen(): boolean {
  for (const handle of escapeMenuHandles) {
    if (handle.isAnyMenuOpen()) return true
  }
  return false
}

export function closeAllWorkbenchEscapeMenus(): void {
  for (const handle of escapeMenuHandles) {
    handle.closeMenus()
  }
}

export function workbenchPanelMountKey(tab?: WorkbenchPanelTab) {
  return tab?.id
}

/**
 * Re-entrancy guard for async tab closing. closeTab awaits the panel's
 * onCloseTab (e.g. terminal pty.remove network round-trip), and during that
 * window the panel itself may report the resource gone (ws close -> reconnect
 * -> validate 404 -> onGone -> onRequestClose -> closeTab again). Two
 * interleaved closeTab calls flush the same <Show keyed> panel tree twice,
 * double-cleaning Solid computations (cleanNode on null.owned) and leaving
 * the panel stuck on "Reconnecting".
 */
export function createTabCloseGuard() {
  const closingTabs = new Set<string>()
  return {
    isClosing(tabId: string) {
      return closingTabs.has(tabId)
    },
    begin(tabId: string) {
      if (closingTabs.has(tabId)) return false
      closingTabs.add(tabId)
      return true
    },
    end(tabId: string) {
      closingTabs.delete(tabId)
    },
  }
}
