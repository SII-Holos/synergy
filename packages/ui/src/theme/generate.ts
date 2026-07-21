import { resolveTheme, themeToCss } from "./resolve"
import { renderThemeSchemaJson } from "@ericsanchezok/synergy-plugin/theme"
import { THEME_TOKEN_NAMES } from "./tokens"
import type { ResolvedTheme, Theme } from "./types"
import { deriveShellSkin } from "./shell-skin"

function declarations(tokens: ResolvedTheme, indentation: string) {
  return themeToCss(tokens)
    .split("\n")
    .map((line) => `${indentation}${line.trim()}`)
    .join("\n")
}

export function renderThemeFallbackCss(theme: Theme): string {
  const resolved = resolveTheme(theme)
  return `/* Generated from the canonical theme resolver. Do not edit manually. */

:root:not([data-color-scheme]) {
  color-scheme: light;
  --text-mix-blend-mode: multiply;
${declarations(resolved.light, "  ")}
}

@media (prefers-color-scheme: dark) {
  :root:not([data-color-scheme]) {
    color-scheme: dark;
    --text-mix-blend-mode: plus-lighter;
${declarations(resolved.dark, "    ")}
  }
}
`
}

export function renderTailwindColorsCss(): string {
  const mappings = THEME_TOKEN_NAMES.map((name) => `  --color-${name}: var(--${name});`).join("\n")
  return `/* Generated from the canonical theme token contract. Do not edit manually. */

@theme {
  --color-*: initial;
${mappings}
}
`
}

export function renderDesktopFallbackSkin(theme: Theme): string {
  const shell = deriveShellSkin(theme)
  const variant = (colors: (typeof shell)["light"], indentation: string) =>
    Object.entries(colors)
      .map(([name, value]) => `${indentation}${name}: ${JSON.stringify(value)},`)
      .join("\n")
  return `/* Generated from the canonical Synergy theme. Do not edit manually. */

export const DEFAULT_DESKTOP_SHELL_SKIN = {
  light: {
${variant(shell.light, "    ")}
  },
  dark: {
${variant(shell.dark, "    ")}
  },
} as const
`
}

export function renderWebBootFallbackCss(theme: Theme): string {
  const shell = deriveShellSkin(theme)
  const declarations = (
    colors: (typeof shell)["light"],
  ) => `        --synergy-boot-bg: ${colors.background.toLowerCase()};
        --synergy-boot-text: ${colors.text.toLowerCase()};
        --synergy-boot-control-color: ${colors.control.toLowerCase()};
        --synergy-boot-control-hover-color: ${colors.controlHover.toLowerCase()};
        --synergy-boot-control-hover-bg: ${colors.controlHoverBackground.toLowerCase()};
        --synergy-boot-focus-ring: ${colors.focus.toLowerCase()};
        --synergy-boot-critical-bg: ${colors.criticalBackground.toLowerCase()};
        --synergy-boot-critical-text: ${colors.criticalText.toLowerCase()};`
  return `      /* Generated from the canonical Synergy theme. Do not edit manually. */
      :root {
${declarations(shell.light)}
      }

      html[data-synergy-color-scheme="dark"] {
${declarations(shell.dark)}
      }

      html[data-synergy-color-scheme="light"] {
${declarations(shell.light)}
      }`
}

export function renderWebThemeColorMeta(theme: Theme): string {
  return `<meta id="synergy-theme-color" name="theme-color" content="${deriveShellSkin(theme).light.background}" />`
}

export { renderThemeSchemaJson }
