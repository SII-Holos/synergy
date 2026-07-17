import type { WorkbenchPanelTab } from "@/plugin/registries/workbench-panel-registry"
import type { WorkbenchSurfaceState } from "./panel-model"

type WorkbenchSurfaceLayoutState = WorkbenchSurfaceState

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeSurfaceState(value: unknown): WorkbenchSurfaceLayoutState | undefined {
  if (!isRecord(value)) return undefined

  const tabs = Array.isArray(value.tabs) ? (value.tabs as WorkbenchPanelTab[]) : []
  return {
    ...value,
    opened: value.opened === true && tabs.length > 0,
    active:
      typeof value.active === "string" && tabs.some((tab) => tab.id === value.active) ? value.active : tabs[0]?.id,
    tabs,
  }
}

function normalizeWorkbenchSurfaces(value: Record<string, unknown>) {
  const next: Record<string, unknown> = {}
  for (const [sessionKey, raw] of Object.entries(value)) {
    const session = isRecord(raw) ? raw : {}
    const side = normalizeSurfaceState(session.side)
    const bottom = normalizeSurfaceState(session.bottom)
    next[sessionKey] = {
      ...session,
      ...(side ? { side } : {}),
      ...(bottom ? { bottom } : {}),
    }
  }
  return next
}

const currentLayoutKeys = ["sidebar", "review", "mobileSidebar", "rightSidebar", "sessionView"] as const

export function migrateWorkbenchLayout(value: unknown): unknown {
  if (!isRecord(value)) return value

  const next: Record<string, unknown> = {}
  for (const key of currentLayoutKeys) {
    if (key in value) next[key] = value[key]
  }
  const oldTerminal = isRecord(value.terminal) ? value.terminal : undefined
  const oldWorkspaceSessions = isRecord(value.workspaceSessions) ? value.workspaceSessions : undefined
  const existingSurfaces = isRecord(value.workbenchSurfaces) ? { ...value.workbenchSurfaces } : {}

  if (oldWorkspaceSessions) {
    for (const [sessionKey, raw] of Object.entries(oldWorkspaceSessions)) {
      if (!isRecord(raw)) continue
      const active = typeof raw.active === "string" ? raw.active : undefined
      const tab: WorkbenchPanelTab | undefined = active ? { id: active, panelId: active } : undefined
      const side: WorkbenchSurfaceLayoutState = {
        opened: raw.opened === true && !!tab,
        active,
        tabs: tab ? [tab] : [],
        size: typeof raw.width === "number" ? raw.width : undefined,
        resized: raw.resized === true,
      }
      const current = isRecord(existingSurfaces[sessionKey]) ? existingSurfaces[sessionKey] : {}
      existingSurfaces[sessionKey] = { ...current, side }
    }
  }

  if (oldTerminal) {
    const height = typeof oldTerminal.height === "number" ? oldTerminal.height : undefined
    for (const [sessionKey, raw] of Object.entries(existingSurfaces)) {
      const current = isRecord(raw) ? raw : {}
      const bottom = isRecord(current.bottom) ? current.bottom : {}
      existingSurfaces[sessionKey] = {
        ...current,
        bottom: {
          ...bottom,
          opened: bottom.opened === true || oldTerminal.opened === true,
          size: typeof bottom.size === "number" ? bottom.size : height,
        },
      }
    }
  }

  next.workbenchSurfaces = normalizeWorkbenchSurfaces(existingSurfaces)
  delete next.terminal
  delete next.workspaceSessions
  return next
}
