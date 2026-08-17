import type { ThemeTokenName } from "./tokens.js"
import type { ThemeSeedInput } from "./schema-contract.js"

export type HexColor = `#${string}`

export interface OklchColor {
  l: number // Lightness 0-1
  c: number // Chroma 0-0.4+
  h: number // Hue 0-360
}

/**
 * Author-facing seed shape: the nine core seeds are required and the four
 * syntax seeds are optional (nine-seed plugin compatibility). The resolver
 * normalizes missing syntax seeds before generating tokens.
 */
export type ThemeSeedColors = ThemeSeedInput

export interface ThemeVariant {
  seeds: ThemeSeedInput
  overrides?: Partial<Record<ThemeTokenName, ColorValue>>
}

export interface Theme {
  $schema?: string
  name: string
  id: string
  light: ThemeVariant
  dark: ThemeVariant
}

export type ThemeToken = ThemeTokenName

export type CssVarRef = `var(--${string})`

export type ColorValue = HexColor | CssVarRef

export type ResolvedTheme = Record<ThemeTokenName, ColorValue>
