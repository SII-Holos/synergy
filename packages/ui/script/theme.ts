#!/usr/bin/env bun

import { synergyTheme } from "../src/theme/default-themes"
import {
  renderDesktopFallbackSkin,
  renderThemeFallbackCss,
  renderThemeSchemaJson,
  renderTailwindColorsCss,
  renderWebBootFallbackCss,
  renderWebThemeColorMeta,
} from "../src/theme/generate"

const appIndexUrl = new URL("../../app/index.html", import.meta.url)
const appIndex = await Bun.file(appIndexUrl).text()
const webFallback = renderWebBootFallbackCss(synergyTheme)
const fallbackPattern =
  /^[ \t]*\/\* BEGIN GENERATED SKIN FALLBACK \*\/[\s\S]*?^[ \t]*\/\* END GENERATED SKIN FALLBACK \*\//m
if (!fallbackPattern.test(appIndex)) throw new Error("Web boot skin fallback markers are missing")
const nextAppIndex = appIndex
  .replace(
    fallbackPattern,
    `      /* BEGIN GENERATED SKIN FALLBACK */\n${webFallback}\n      /* END GENERATED SKIN FALLBACK */`,
  )
  .replace(
    /<meta id="synergy-theme-color" name="theme-color" content="#[0-9a-fA-F]+" \/>/,
    renderWebThemeColorMeta(synergyTheme),
  )

await Promise.all([
  Bun.write(new URL("../src/styles/theme.generated.css", import.meta.url), renderThemeFallbackCss(synergyTheme)),
  Bun.write(new URL("../src/styles/tailwind/colors.css", import.meta.url), renderTailwindColorsCss()),
  Bun.write(new URL("../src/theme/theme.schema.json", import.meta.url), renderThemeSchemaJson()),
  Bun.write(
    new URL("../../desktop/src/default-shell-skin.generated.ts", import.meta.url),
    renderDesktopFallbackSkin(synergyTheme),
  ),
  Bun.write(appIndexUrl, nextAppIndex),
])
