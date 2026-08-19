import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import z from "zod"

export const DesktopZoomStateV1 = z
  .object({
    version: z.literal(1),
    zoomFactor: z.number().min(0.5).max(2),
  })
  .strict()
export type DesktopZoomStateV1 = z.infer<typeof DesktopZoomStateV1>

export const DEFAULT_DESKTOP_ZOOM_FACTOR = 1

const DESKTOP_ZOOM_FILE = "desktop-zoom.json"

type DesktopZoomWindow = {
  isDestroyed(): boolean
  webContents: {
    setZoomFactor(factor: number): void
  }
}

export function desktopZoomFilePath(userDataPath: string): string {
  return path.join(userDataPath, DESKTOP_ZOOM_FILE)
}

export function defaultDesktopZoomState(): DesktopZoomStateV1 {
  return { version: 1, zoomFactor: DEFAULT_DESKTOP_ZOOM_FACTOR }
}

export async function loadDesktopZoom(userDataPath: string): Promise<DesktopZoomStateV1> {
  try {
    const content = await readFile(desktopZoomFilePath(userDataPath), "utf8")
    const parsed = DesktopZoomStateV1.safeParse(JSON.parse(content))
    if (parsed.success) return parsed.data
  } catch {
    // Missing or unreadable state falls back to the default zoom factor.
  }
  return defaultDesktopZoomState()
}

export async function saveDesktopZoom(userDataPath: string, state: DesktopZoomStateV1): Promise<void> {
  const filepath = desktopZoomFilePath(userDataPath)
  await mkdir(path.dirname(filepath), { recursive: true })
  await writeFile(filepath, `${JSON.stringify(state, null, 2)}\n`)
}

export function applyDesktopZoomToWindow(window: DesktopZoomWindow, state: DesktopZoomStateV1): void {
  if (window.isDestroyed()) return
  window.webContents.setZoomFactor(state.zoomFactor)
}

export function parseDesktopZoomFactor(input: unknown): number {
  return z.number().min(0.5).max(2).parse(input)
}
