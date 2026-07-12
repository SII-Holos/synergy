#!/usr/bin/env bun

import { synergyTheme } from "../src/theme/default-themes"
import { renderThemeFallbackCss, renderThemeSchemaJson, renderTailwindColorsCss } from "../src/theme/generate"

await Promise.all([
  Bun.write(new URL("../src/styles/theme.generated.css", import.meta.url), renderThemeFallbackCss(synergyTheme)),
  Bun.write(new URL("../src/styles/tailwind/colors.css", import.meta.url), renderTailwindColorsCss()),
  Bun.write(new URL("../src/theme/theme.schema.json", import.meta.url), renderThemeSchemaJson()),
])
