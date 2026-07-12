import type { Theme } from "./types"
import synergyThemeJson from "./themes/synergy.json"
import { parseTheme } from "./schema"

export const synergyTheme: Theme = parseTheme(synergyThemeJson)
