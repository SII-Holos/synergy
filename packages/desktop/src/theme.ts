import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import z from "zod"

export const DesktopThemeSource = z.enum(["system", "light", "dark"])
export type DesktopThemeSource = z.infer<typeof DesktopThemeSource>

export type DesktopThemeEffective = "light" | "dark"

export type DesktopThemeSnapshot = {
  source: DesktopThemeSource
  effective: DesktopThemeEffective
}

export type DesktopThemeEvent = {
  type: "theme"
  snapshot: DesktopThemeSnapshot
}

type DesktopThemeWindow = {
  isDestroyed(): boolean
  setBackgroundColor(backgroundColor: string): void
}

const DESKTOP_THEME_FILE = "desktop-theme.json"
const PersistedDesktopTheme = z.object({
  source: DesktopThemeSource,
})

export function desktopThemeFilePath(userDataDir: string): string {
  return path.join(userDataDir, DESKTOP_THEME_FILE)
}

export function parseDesktopThemeSource(input: unknown): DesktopThemeSource {
  return DesktopThemeSource.parse(input)
}

export async function loadDesktopThemeSource(userDataDir: string): Promise<DesktopThemeSource> {
  try {
    const content = await readFile(desktopThemeFilePath(userDataDir), "utf8")
    return PersistedDesktopTheme.parse(JSON.parse(content)).source
  } catch {
    return "system"
  }
}

export async function saveDesktopThemeSource(userDataDir: string, source: DesktopThemeSource): Promise<void> {
  await mkdir(userDataDir, { recursive: true })
  await writeFile(desktopThemeFilePath(userDataDir), `${JSON.stringify({ source }, null, 2)}\n`, "utf8")
}

export function resolveDesktopThemeEffective(
  source: DesktopThemeSource,
  shouldUseDarkColors: boolean,
): DesktopThemeEffective {
  if (source === "system") return shouldUseDarkColors ? "dark" : "light"
  return source
}

export function desktopThemeSnapshot(source: DesktopThemeSource, shouldUseDarkColors: boolean): DesktopThemeSnapshot {
  return {
    source,
    effective: resolveDesktopThemeEffective(source, shouldUseDarkColors),
  }
}

export function desktopThemeBackground(effective: DesktopThemeEffective): string {
  return effective === "dark" ? "#0F0F10" : "#FAFAFA"
}

export function applyDesktopThemeToWindow(window: DesktopThemeWindow, snapshot: DesktopThemeSnapshot): void {
  if (window.isDestroyed()) return
  window.setBackgroundColor(desktopThemeBackground(snapshot.effective))
}
