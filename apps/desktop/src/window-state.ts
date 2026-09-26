import { screen, type BrowserWindow, type Rectangle } from "electron"
import fs from "node:fs/promises"
import path from "node:path"

export interface DesktopWindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized?: boolean
}

const DEFAULT_WINDOW_STATE: DesktopWindowState = {
  width: 1440,
  height: 920,
}

export async function loadWindowState(userDataPath: string): Promise<DesktopWindowState> {
  try {
    const content = await fs.readFile(windowStatePath(userDataPath), "utf8")
    const parsed = JSON.parse(content) as Partial<DesktopWindowState>
    const state = normalizeWindowState(parsed)
    return fitWindowState(state)
  } catch {
    return fitWindowState(DEFAULT_WINDOW_STATE)
  }
}

export function scheduleWindowStatePersistence(window: BrowserWindow, userDataPath: string): void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const persist = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      void saveWindowState(window, userDataPath)
    }, 250)
  }

  window.on("resize", persist)
  window.on("move", persist)
  window.on("maximize", persist)
  window.on("unmaximize", persist)
  window.on("close", () => {
    if (timer) clearTimeout(timer)
    void saveWindowState(window, userDataPath)
  })
}

async function saveWindowState(window: BrowserWindow, userDataPath: string): Promise<void> {
  if (window.isDestroyed()) return
  const bounds = window.getNormalBounds()
  const state: DesktopWindowState = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized: window.isMaximized(),
  }
  const filepath = windowStatePath(userDataPath)
  await fs.mkdir(path.dirname(filepath), { recursive: true })
  await fs.writeFile(filepath, `${JSON.stringify(state, null, 2)}\n`)
}

function normalizeWindowState(input: Partial<DesktopWindowState>): DesktopWindowState {
  const width = positiveInteger(input.width) ?? DEFAULT_WINDOW_STATE.width
  const height = positiveInteger(input.height) ?? DEFAULT_WINDOW_STATE.height
  const state: DesktopWindowState = {
    width,
    height,
    maximized: input.maximized === true,
  }
  if (typeof input.x === "number" && Number.isFinite(input.x)) state.x = Math.round(input.x)
  if (typeof input.y === "number" && Number.isFinite(input.y)) state.y = Math.round(input.y)
  return state
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined
}

function fitWindowState(state: DesktopWindowState): DesktopWindowState {
  const primary = screen.getPrimaryDisplay().workArea
  const areas = screen.getAllDisplays().map((display) => display.workArea)
  const area =
    state.x === undefined || state.y === undefined
      ? primary
      : areas.reduce(
          (best, next) => (intersectionArea(state, next) > intersectionArea(state, best) ? next : best),
          primary,
        )
  const width = Math.min(Math.max(640, state.width), area.width)
  const height = Math.min(Math.max(480, state.height), area.height)
  if (state.x === undefined || state.y === undefined) return { ...state, width, height }
  return {
    ...state,
    width,
    height,
    x: Math.max(area.x, Math.min(state.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(state.y, area.y + area.height - height)),
  }
}

function intersectionArea(state: DesktopWindowState, area: Rectangle): number {
  const x = state.x ?? area.x
  const y = state.y ?? area.y
  return (
    Math.max(0, Math.min(x + state.width, area.x + area.width) - Math.max(x, area.x)) *
    Math.max(0, Math.min(y + state.height, area.y + area.height) - Math.max(y, area.y))
  )
}

function windowStatePath(userDataPath: string): string {
  return path.join(userDataPath, "window-state.json")
}
