import type { WorkbenchPanelTab } from "@/plugin/registries/workbench-panel-registry"
import type { WorkbenchSurfaceState } from "./workbench-panels-model"

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

function legacyFilePath(value: string) {
  if (!value.startsWith("file://")) return undefined
  const withoutSuffix = value.slice("file://".length).split(/[?#]/, 1)[0] ?? ""
  let decoded: string
  try {
    decoded = decodeURIComponent(withoutSuffix)
  } catch {
    console.warn("Dropping invalid legacy file tab during layout migration")
    return undefined
  }
  const normalized = decoded.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "")
  if (!normalized || normalized.includes("\0") || normalized.split("/").includes("..")) {
    console.warn("Dropping unsafe legacy file tab during layout migration")
    return undefined
  }
  return normalized
}

function basename(value: string) {
  return value.split("/").at(-1) ?? value
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

  const sessionTabs = isRecord(value.sessionTabs) ? { ...value.sessionTabs } : {}
  for (const [sessionKey, raw] of Object.entries(sessionTabs)) {
    if (!isRecord(raw)) continue
    const all = Array.isArray(raw.all) ? raw.all.filter((tab): tab is string => typeof tab === "string") : []
    const legacyFiles = all.map(legacyFilePath).filter((file): file is string => !!file)
    if (legacyFiles.length === 0) continue

    const current = isRecord(existingSurfaces[sessionKey]) ? existingSurfaces[sessionKey] : {}
    const currentSide = normalizeSurfaceState(current.side) ?? { opened: false, tabs: [] }
    const tabs = [...(currentSide.tabs ?? [])]
    for (const file of legacyFiles) {
      if (tabs.some((tab) => tab.panelId === "file" && tab.resourceId === file)) continue
      tabs.push({
        id: `file:${file}`,
        panelId: "file",
        resourceId: file,
        title: basename(file),
        source: "migration",
      })
    }

    const activeLegacyFile = typeof raw.active === "string" ? legacyFilePath(raw.active) : undefined
    const activeFileTab = activeLegacyFile
      ? tabs.find((tab) => tab.panelId === "file" && tab.resourceId === activeLegacyFile)
      : undefined
    existingSurfaces[sessionKey] = {
      ...current,
      side: {
        ...currentSide,
        tabs,
        opened: activeFileTab ? true : currentSide.opened,
        active: activeFileTab?.id ?? currentSide.active,
      },
    }

    const contextOpen = all.includes("context")
    sessionTabs[sessionKey] = {
      ...raw,
      all: contextOpen ? ["context"] : [],
      active: raw.active === "context" || (activeFileTab && contextOpen) ? "context" : undefined,
    }
  }

  next.workbenchSurfaces = normalizeWorkbenchSurfaces(existingSurfaces)
  next.sessionTabs = sessionTabs
  delete next.terminal
  delete next.workspaceSessions
  return next
}
