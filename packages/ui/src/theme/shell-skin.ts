import z from "zod"
import { resolveTheme, resolveThemeColor, type HexColor, type Theme } from "@ericsanchezok/synergy-plugin/theme"
import { ThemeSchema, parseTheme } from "./schema"

export const SKIN_BOOTSTRAP_STORAGE_KEY = "synergy-skin-cache-v1"

const HexColorSchema = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/)

export const ShellSkinColorsSchema = z
  .object({
    background: HexColorSchema,
    text: HexColorSchema,
    mutedText: HexColorSchema,
    panel: HexColorSchema,
    border: HexColorSchema,
    control: HexColorSchema,
    controlHover: HexColorSchema,
    controlHoverBackground: HexColorSchema,
    focus: HexColorSchema,
    markBackground: HexColorSchema,
    markText: HexColorSchema,
    criticalBackground: HexColorSchema,
    criticalText: HexColorSchema,
  })
  .strict()

export type ShellSkinColors = z.infer<typeof ShellSkinColorsSchema>

export const ShellSkinSnapshotSchema = z
  .object({
    light: ShellSkinColorsSchema,
    dark: ShellSkinColorsSchema,
  })
  .strict()

export type ShellSkinSnapshot = z.infer<typeof ShellSkinSnapshotSchema>

export const SkinBootstrapSnapshotSchema = z
  .object({
    version: z.literal(1),
    themeId: z.string().min(1),
    theme: ThemeSchema,
    shell: ShellSkinSnapshotSchema,
  })
  .strict()

export interface SkinBootstrapSnapshot {
  version: 1
  themeId: string
  theme: Theme
  shell: ShellSkinSnapshot
}

function shellColors(tokens: ReturnType<typeof resolveTheme>["light"]): ShellSkinColors {
  const color = (token: Parameters<typeof resolveThemeColor>[1]): HexColor => resolveThemeColor(tokens, token)
  return {
    background: color("background-stronger"),
    text: color("text-base"),
    mutedText: color("text-weak"),
    panel: color("surface-raised-base"),
    border: color("border-base"),
    control: color("icon-weak-base"),
    controlHover: color("icon-strong-hover"),
    controlHoverBackground: color("button-ghost-hover"),
    focus: color("border-focus"),
    markBackground: color("surface-brand-base"),
    markText: color("text-on-brand-base"),
    criticalBackground: color("surface-critical-base"),
    criticalText: color("text-on-critical-base"),
  }
}

export function deriveShellSkin(theme: Theme): ShellSkinSnapshot {
  const resolved = resolveTheme(theme)
  return { light: shellColors(resolved.light), dark: shellColors(resolved.dark) }
}

export function createSkinBootstrapSnapshot(themeId: string, theme: Theme): SkinBootstrapSnapshot {
  const validatedTheme = parseTheme(theme)
  return {
    version: 1,
    themeId,
    theme: validatedTheme,
    shell: deriveShellSkin(validatedTheme),
  }
}

type SkinStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

export function readSkinBootstrapSnapshot(
  storage: Pick<Storage, "getItem"> = localStorage,
): SkinBootstrapSnapshot | null {
  try {
    const input = storage.getItem(SKIN_BOOTSTRAP_STORAGE_KEY)
    if (!input) return null
    const parsed = SkinBootstrapSnapshotSchema.parse(JSON.parse(input))
    return createSkinBootstrapSnapshot(parsed.themeId, parseTheme(parsed.theme))
  } catch {
    return null
  }
}

export function writeSkinBootstrapSnapshot(snapshot: SkinBootstrapSnapshot, storage: SkinStorage = localStorage) {
  try {
    storage.setItem(SKIN_BOOTSTRAP_STORAGE_KEY, JSON.stringify(SkinBootstrapSnapshotSchema.parse(snapshot)))
  } catch {
    storage.removeItem(SKIN_BOOTSTRAP_STORAGE_KEY)
  }
}
