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
    return isVisibleOnAnyDisplay(state) ? state : DEFAULT_WINDOW_STATE
  } catch {
    return DEFAULT_WINDOW_STATE
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

function isVisibleOnAnyDisplay(state: DesktopWindowState): boolean {
  if (state.x === undefined || state.y === undefined) return true
  const bounds: Rectangle = {
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
  }
  return screen.getAllDisplays().some((display) => intersects(bounds, display.workArea))
}

function intersects(a: Rectangle, b: Rectangle): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

function windowStatePath(userDataPath: string): string {
  return path.join(userDataPath, "window-state.json")
}
