import type { HexColor, Theme } from "./types"
import synergyThemeJson from "./themes/synergy.json"
import { parseTheme } from "./schema"

export const synergyTheme: Theme = parseTheme(synergyThemeJson)

type SeedPalette = {
  neutral: HexColor
  primary: HexColor
  success: HexColor
  warning: HexColor
  error: HexColor
  info: HexColor
  interactive: HexColor
  diffAdd: HexColor
  diffDelete: HexColor
  syntaxString: HexColor
  syntaxKeyword: HexColor
  syntaxType: HexColor
  syntaxProperty: HexColor
}

function createTheme(id: string, name: string, light: SeedPalette, dark: SeedPalette): Theme {
  return parseTheme({ id, name, light: { seeds: light }, dark: { seeds: dark } })
}

// Catppuccin Latte / Mocha palette, MIT: https://github.com/catppuccin/palette
export const catppuccinTheme = createTheme(
  "catppuccin",
  "Catppuccin",
  {
    neutral: "#5C5F77",
    primary: "#1E66F5",
    success: "#40A02B",
    warning: "#DF8E1D",
    error: "#D20F39",
    info: "#1E66F5",
    interactive: "#1E66F5",
    diffAdd: "#40A02B",
    diffDelete: "#D20F39",
    syntaxString: "#40A02B",
    syntaxKeyword: "#8839EF",
    syntaxType: "#179299",
    syntaxProperty: "#1A5CCF",
  },
  {
    neutral: "#BAC2DE",
    primary: "#89B4FA",
    success: "#A6E3A1",
    warning: "#F9E2AF",
    error: "#F38BA8",
    info: "#89B4FA",
    interactive: "#89B4FA",
    diffAdd: "#A6E3A1",
    diffDelete: "#F38BA8",
    syntaxString: "#A6E3A1",
    syntaxKeyword: "#CBA6F7",
    syntaxType: "#94E2D5",
    syntaxProperty: "#89B4FA",
  },
)

// Tokyo Night Day / Moon palette, Apache-2.0: https://github.com/folke/tokyonight.nvim
export const tokyoNightTheme = createTheme(
  "tokyo-night",
  "Tokyo Night",
  {
    neutral: "#4C5F97",
    primary: "#2E7DE9",
    success: "#587539",
    warning: "#B15C00",
    error: "#F52A65",
    info: "#2E7DE9",
    interactive: "#2E7DE9",
    diffAdd: "#587539",
    diffDelete: "#F52A65",
    syntaxString: "#587539",
    syntaxKeyword: "#7847BD",
    syntaxType: "#007197",
    syntaxProperty: "#34548A",
  },
  {
    neutral: "#A9B1D6",
    primary: "#82AAFF",
    success: "#C3E88D",
    warning: "#FFC777",
    error: "#FF757F",
    info: "#82AAFF",
    interactive: "#82AAFF",
    diffAdd: "#C3E88D",
    diffDelete: "#FF757F",
    syntaxString: "#C3E88D",
    syntaxKeyword: "#C099FF",
    syntaxType: "#86E1FC",
    syntaxProperty: "#82AAFF",
  },
)

// Ayu Light / Mirage palette, MIT: https://github.com/ayu-theme/ayu-colors
export const ayuTheme = createTheme(
  "ayu",
  "Ayu",
  {
    neutral: "#6C7680",
    primary: "#FF9940",
    success: "#6A9F00",
    warning: "#C58B00",
    error: "#E65050",
    info: "#FF9940",
    interactive: "#FF9940",
    diffAdd: "#6A9F00",
    diffDelete: "#E65050",
    syntaxString: "#6A9F00",
    syntaxKeyword: "#A37ACC",
    syntaxType: "#399EE6",
    syntaxProperty: "#005CC5",
  },
  {
    neutral: "#B8C0CC",
    primary: "#FFCC66",
    success: "#BAE67E",
    warning: "#FFCC66",
    error: "#F07178",
    info: "#FFCC66",
    interactive: "#FFCC66",
    diffAdd: "#BAE67E",
    diffDelete: "#F07178",
    syntaxString: "#BAE67E",
    syntaxKeyword: "#D2A6FF",
    syntaxType: "#73D0FF",
    syntaxProperty: "#73D0FF",
  },
)

// Rose Pine Dawn / Moon palette, MIT: https://github.com/rose-pine/rose-pine-theme
export const rosePineTheme = createTheme(
  "rose-pine",
  "Rose Pine",
  {
    neutral: "#6E6A86",
    primary: "#907AA9",
    success: "#56949F",
    warning: "#EA9D34",
    error: "#B4637A",
    info: "#907AA9",
    interactive: "#907AA9",
    diffAdd: "#56949F",
    diffDelete: "#B4637A",
    syntaxString: "#56949F",
    syntaxKeyword: "#907AA9",
    syntaxType: "#286983",
    syntaxProperty: "#286983",
  },
  {
    neutral: "#C4C1D8",
    primary: "#C4A7E7",
    success: "#9CCFD8",
    warning: "#F6C177",
    error: "#EB6F92",
    info: "#C4A7E7",
    interactive: "#C4A7E7",
    diffAdd: "#9CCFD8",
    diffDelete: "#EB6F92",
    syntaxString: "#9CCFD8",
    syntaxKeyword: "#C4A7E7",
    syntaxType: "#3E8FB0",
    syntaxProperty: "#9CCFD8",
  },
)

// Kanagawa Lotus / Wave palette, MIT: https://github.com/rebelot/kanagawa.nvim
export const kanagawaTheme = createTheme(
  "kanagawa",
  "Kanagawa",
  {
    neutral: "#6A6A84",
    primary: "#4D699B",
    success: "#6F894E",
    warning: "#77713F",
    error: "#C84053",
    info: "#4D699B",
    interactive: "#4D699B",
    diffAdd: "#6F894E",
    diffDelete: "#C84053",
    syntaxString: "#6F894E",
    syntaxKeyword: "#624C83",
    syntaxType: "#597B75",
    syntaxProperty: "#4D699B",
  },
  {
    neutral: "#C8C093",
    primary: "#7E9CD8",
    success: "#98BB6C",
    warning: "#E6C384",
    error: "#E46876",
    info: "#7E9CD8",
    interactive: "#7E9CD8",
    diffAdd: "#98BB6C",
    diffDelete: "#E46876",
    syntaxString: "#98BB6C",
    syntaxKeyword: "#957FB8",
    syntaxType: "#7AA89F",
    syntaxProperty: "#7FB4CA",
  },
)

// Everforest Light / Dark palette, MIT: https://github.com/sainnhe/everforest
export const everforestTheme = createTheme(
  "everforest",
  "Everforest",
  {
    neutral: "#58656C",
    primary: "#3A94C5",
    success: "#8DA101",
    warning: "#DFA000",
    error: "#F85552",
    info: "#3A94C5",
    interactive: "#3A94C5",
    diffAdd: "#8DA101",
    diffDelete: "#F85552",
    syntaxString: "#8DA101",
    syntaxKeyword: "#DF69BA",
    syntaxType: "#35A77C",
    syntaxProperty: "#2377A4",
  },
  {
    neutral: "#B9B89A",
    primary: "#7FBBB3",
    success: "#A7C080",
    warning: "#DBBC7F",
    error: "#E67E80",
    info: "#7FBBB3",
    interactive: "#7FBBB3",
    diffAdd: "#A7C080",
    diffDelete: "#E67E80",
    syntaxString: "#A7C080",
    syntaxKeyword: "#D699B6",
    syntaxType: "#83C092",
    syntaxProperty: "#83C092",
  },
)

// Solarized Light / Dark palette, MIT: https://github.com/altercation/solarized
export const solarizedTheme = createTheme(
  "solarized",
  "Solarized",
  {
    neutral: "#4F6369",
    primary: "#268BD2",
    success: "#859900",
    warning: "#B58900",
    error: "#DC322F",
    info: "#268BD2",
    interactive: "#268BD2",
    diffAdd: "#859900",
    diffDelete: "#DC322F",
    syntaxString: "#859900",
    syntaxKeyword: "#6C71C4",
    syntaxType: "#2AA198",
    syntaxProperty: "#00758F",
  },
  {
    neutral: "#93A1A1",
    primary: "#2AA198",
    success: "#859900",
    warning: "#B58900",
    error: "#DC322F",
    info: "#2AA198",
    interactive: "#2AA198",
    diffAdd: "#859900",
    diffDelete: "#DC322F",
    syntaxString: "#859900",
    syntaxKeyword: "#6C71C4",
    syntaxType: "#268BD2",
    syntaxProperty: "#2AA198",
  },
)

export const builtinThemes = [
  synergyTheme,
  catppuccinTheme,
  tokyoNightTheme,
  ayuTheme,
  rosePineTheme,
  kanagawaTheme,
  everforestTheme,
  solarizedTheme,
] as const
