import type { WorkbenchPanelTab } from "@/plugin/registries/workbench-panel-registry"
import type { WorkbenchSurfaceState } from "./workbench-panels-model"

type WorkbenchSurfaceLayoutState = WorkbenchSurfaceState

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function migrateWorkbenchLayout(value: unknown): unknown {
  if (!isRecord(value)) return value

  const next: Record<string, unknown> = { ...value }
  const oldTerminal = isRecord(value.terminal) ? value.terminal : undefined
  const oldWorkspaceSessions = isRecord(value.workspaceSessions) ? value.workspaceSessions : undefined
  const existingSurfaces = isRecord(value.workbenchSurfaces) ? { ...value.workbenchSurfaces } : {}

  if (oldWorkspaceSessions) {
    for (const [sessionKey, raw] of Object.entries(oldWorkspaceSessions)) {
      if (!isRecord(raw)) continue
      const active = typeof raw.active === "string" ? raw.active : undefined
      const tab: WorkbenchPanelTab | undefined = active ? { id: active, panelId: active } : undefined
      const side: WorkbenchSurfaceLayoutState = {
        opened: raw.opened === true,
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

  next.workbenchSurfaces = existingSurfaces
  delete next.terminal
  delete next.workspaceSessions
  return next
}
