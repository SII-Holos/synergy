import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { DEFAULT_DESKTOP_SHELL_SKIN } from "./default-shell-skin.generated.js"

export const DesktopThemeSource = z.enum(["system", "light", "dark"])
export type DesktopThemeSource = z.infer<typeof DesktopThemeSource>
export type DesktopThemeEffective = "light" | "dark"

const HexColor = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/)

export const DesktopShellSkinColors = z
  .object({
    background: HexColor,
    text: HexColor,
    mutedText: HexColor,
    panel: HexColor,
    border: HexColor,
    control: HexColor,
    controlHover: HexColor,
    controlHoverBackground: HexColor,
    focus: HexColor,
    markBackground: HexColor,
    markText: HexColor,
    criticalBackground: HexColor,
    criticalText: HexColor,
  })
  .strict()
export type DesktopShellSkinColors = z.infer<typeof DesktopShellSkinColors>

const DesktopSkinFields = {
  source: DesktopThemeSource,
  themeId: z.string().min(1),
  light: DesktopShellSkinColors,
  dark: DesktopShellSkinColors,
}

export const DesktopSkinUpdateV2 = z.object(DesktopSkinFields).strict()
export type DesktopSkinUpdateV2 = z.infer<typeof DesktopSkinUpdateV2>

export const DesktopSkinStateV2 = z.object({ version: z.literal(2), ...DesktopSkinFields }).strict()
export type DesktopSkinStateV2 = z.infer<typeof DesktopSkinStateV2>

export type DesktopThemeSnapshot = DesktopSkinStateV2 & {
  effective: DesktopThemeEffective
  colors: DesktopShellSkinColors
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
const LegacyDesktopTheme = z.object({ source: DesktopThemeSource }).strict()

export function desktopThemeFilePath(userDataDir: string): string {
  return path.join(userDataDir, DESKTOP_THEME_FILE)
}

export function parseDesktopThemeSource(input: unknown): DesktopThemeSource {
  return DesktopThemeSource.parse(input)
}

export function parseDesktopSkinUpdate(input: unknown): DesktopSkinUpdateV2 {
  return DesktopSkinUpdateV2.parse(input)
}

export function defaultDesktopSkinState(source: DesktopThemeSource = "system"): DesktopSkinStateV2 {
  return DesktopSkinStateV2.parse({
    version: 2,
    source,
    themeId: "synergy",
    ...DEFAULT_DESKTOP_SHELL_SKIN,
  })
}

export async function loadDesktopSkinState(userDataDir: string): Promise<DesktopSkinStateV2> {
  try {
    const content = await readFile(desktopThemeFilePath(userDataDir), "utf8")
    const input: unknown = JSON.parse(content)
    const current = DesktopSkinStateV2.safeParse(input)
    if (current.success) return current.data
    const legacy = LegacyDesktopTheme.safeParse(input)
    if (!legacy.success) return defaultDesktopSkinState()
    const migrated = defaultDesktopSkinState(legacy.data.source)
    await saveDesktopSkinState(userDataDir, migrated)
    return migrated
  } catch {
    return defaultDesktopSkinState()
  }
}

export async function saveDesktopSkinState(userDataDir: string, state: DesktopSkinStateV2): Promise<void> {
  const parsed = DesktopSkinStateV2.parse(state)
  await mkdir(userDataDir, { recursive: true })
  const target = desktopThemeFilePath(userDataDir)
  const temporary = `${target}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, "utf8")
  await rename(temporary, target)
}

export function resolveDesktopThemeEffective(
  source: DesktopThemeSource,
  shouldUseDarkColors: boolean,
): DesktopThemeEffective {
  if (source === "system") return shouldUseDarkColors ? "dark" : "light"
  return source
}

export function desktopThemeSnapshot(state: DesktopSkinStateV2, shouldUseDarkColors: boolean): DesktopThemeSnapshot {
  const effective = resolveDesktopThemeEffective(state.source, shouldUseDarkColors)
  return { ...state, effective, colors: state[effective] }
}

export function desktopThemeBackground(snapshot: DesktopThemeSnapshot): string {
  return snapshot.colors.background
}

export function applyDesktopThemeToWindow(window: DesktopThemeWindow, snapshot: DesktopThemeSnapshot): void {
  if (window.isDestroyed()) return
  window.setBackgroundColor(desktopThemeBackground(snapshot))
}
