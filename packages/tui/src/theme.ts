export type TuiPalette = {
  background: string
  surface: string
  surfaceInset: string
  surfaceRaised: string
  borderHairline: string
  border: string
  borderStrong: string
  borderFocus: string
  textStrong: string
  text: string
  textWeak: string
  textWeaker: string
  textSubtle: string
  interactive: string
  success: string
  warning: string
  danger: string
  selected: string
  selectedText: string
  addedBackground: string
  removedBackground: string
}

const PALETTES: Record<"light" | "dark", TuiPalette> = {
  dark: {
    background: "#0F0F10",
    surface: "#1B1B1D",
    surfaceInset: "#222326",
    surfaceRaised: "#2A2B2F",
    borderHairline: "#26262A",
    border: "#313136",
    borderStrong: "#3A3A40",
    borderFocus: "#60A5FA",
    textStrong: "#FAFAFA",
    text: "#F4F4F5",
    textWeak: "#D4D4D8",
    textWeaker: "#A1A1AA",
    textSubtle: "#71717A",
    interactive: "#60A5FA",
    success: "#34D399",
    warning: "#FBBF24",
    danger: "#F87171",
    selected: "#2A2B2F",
    selectedText: "#FAFAFA",
    addedBackground: "#12301F",
    removedBackground: "#351A1D",
  },
  light: {
    background: "#FAFAFA",
    surface: "#FFFFFF",
    surfaceInset: "#F4F4F5",
    surfaceRaised: "#FFFFFF",
    borderHairline: "#E5E6E8",
    border: "#DCDEE2",
    borderStrong: "#C9CCD2",
    borderFocus: "#2563EB",
    textStrong: "#030712",
    text: "#111827",
    textWeak: "#374151",
    textWeaker: "#6B7280",
    textSubtle: "#9CA3AF",
    interactive: "#2563EB",
    success: "#15803D",
    warning: "#B45309",
    danger: "#DC2626",
    selected: "#F1F2F4",
    selectedText: "#030712",
    addedBackground: "#DCFCE7",
    removedBackground: "#FEE2E2",
  },
}

export function getTuiPalette(mode: "light" | "dark") {
  return PALETTES[mode]
}
