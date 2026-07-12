import type { HexColor, OklchColor } from "./types"
import { HEX_COLOR_REGEX } from "./schema-contract"

function normalizeHex(hex: HexColor): string {
  const value = hex.slice(1)
  if (!HEX_COLOR_REGEX.test(hex)) {
    throw new Error(`Invalid hex color: ${hex}`)
  }
  if (value.length === 3 || value.length === 4) {
    return value
      .split("")
      .map((channel) => channel + channel)
      .join("")
  }
  return value
}

export function hexToRgb(hex: HexColor): { r: number; g: number; b: number } {
  const value = normalizeHex(hex)
  return {
    r: Number.parseInt(value.slice(0, 2), 16) / 255,
    g: Number.parseInt(value.slice(2, 4), 16) / 255,
    b: Number.parseInt(value.slice(4, 6), 16) / 255,
  }
}

function hexAlpha(hex: HexColor): number {
  const value = normalizeHex(hex)
  return value.length === 8 ? Number.parseInt(value.slice(6, 8), 16) / 255 : 1
}

export function rgbToHex(r: number, g: number, b: number): HexColor {
  const toHex = (v: number) => {
    const clamped = Math.max(0, Math.min(1, v))
    const int = Math.round(clamped * 255)
    return int.toString(16).padStart(2, "0")
  }
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

function linearToSrgb(c: number): number {
  if (c <= 0.0031308) return c * 12.92
  return 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}

function srgbToLinear(c: number): number {
  if (c <= 0.04045) return c / 12.92
  return Math.pow((c + 0.055) / 1.055, 2.4)
}

export function rgbToOklch(r: number, g: number, b: number): OklchColor {
  const lr = srgbToLinear(r)
  const lg = srgbToLinear(g)
  const lb = srgbToLinear(b)

  const l_ = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb
  const m_ = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb
  const s_ = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb

  const l = Math.cbrt(l_)
  const m = Math.cbrt(m_)
  const s = Math.cbrt(s_)

  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const bOk = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s

  const C = Math.sqrt(a * a + bOk * bOk)
  let H = Math.atan2(bOk, a) * (180 / Math.PI)
  if (H < 0) H += 360

  return { l: L, c: C, h: H }
}

export function oklchToRgb(oklch: OklchColor): { r: number; g: number; b: number } {
  const { l: L, c: C, h: H } = oklch

  const a = C * Math.cos((H * Math.PI) / 180)
  const b = C * Math.sin((H * Math.PI) / 180)

  const l = L + 0.3963377774 * a + 0.2158037573 * b
  const m = L - 0.1055613458 * a - 0.0638541728 * b
  const s = L - 0.0894841775 * a - 1.291485548 * b

  const l3 = l * l * l
  const m3 = m * m * m
  const s3 = s * s * s

  const lr = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3
  const lg = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3
  const lb = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3

  return {
    r: linearToSrgb(lr),
    g: linearToSrgb(lg),
    b: linearToSrgb(lb),
  }
}

export function hexToOklch(hex: HexColor): OklchColor {
  const { r, g, b } = hexToRgb(hex)
  return rgbToOklch(r, g, b)
}

export function oklchToHex(oklch: OklchColor): HexColor {
  const { r, g, b } = oklchToRgb(oklch)
  return rgbToHex(r, g, b)
}

function relativeLuminance(color: { r: number; g: number; b: number }): number {
  const channels = [color.r, color.g, color.b].map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  )
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

export function contrastRatio(foreground: HexColor, background: HexColor): number {
  if (hexAlpha(background) !== 1) throw new Error(`Contrast background must be opaque: ${background}`)

  const backgroundRgb = hexToRgb(background)
  const foregroundRgb = hexToRgb(foreground)
  const foregroundAlpha = hexAlpha(foreground)
  const composite = {
    r: foregroundRgb.r * foregroundAlpha + backgroundRgb.r * (1 - foregroundAlpha),
    g: foregroundRgb.g * foregroundAlpha + backgroundRgb.g * (1 - foregroundAlpha),
    b: foregroundRgb.b * foregroundAlpha + backgroundRgb.b * (1 - foregroundAlpha),
  }
  const foregroundLuminance = relativeLuminance(composite)
  const backgroundLuminance = relativeLuminance(backgroundRgb)
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  )
}

export function generateScale(seed: HexColor, isDark: boolean): HexColor[] {
  const base = hexToOklch(seed)
  const scale: HexColor[] = []

  const lightSteps = isDark
    ? [0.15, 0.18, 0.22, 0.26, 0.32, 0.38, 0.46, 0.56, base.l, base.l - 0.05, 0.75, 0.93]
    : [0.99, 0.97, 0.94, 0.9, 0.85, 0.79, 0.72, 0.64, base.l, base.l + 0.05, 0.45, 0.25]

  const chromaMultipliers = isDark
    ? [0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.85, 1, 1, 0.9, 0.6]
    : [0.1, 0.15, 0.25, 0.35, 0.45, 0.55, 0.7, 0.85, 1, 1, 0.95, 0.85]

  for (let i = 0; i < 12; i++) {
    scale.push(
      oklchToHex({
        l: lightSteps[i],
        c: base.c * chromaMultipliers[i],
        h: base.h,
      }),
    )
  }

  return scale
}

function isSrgbColor({ r, g, b }: { r: number; g: number; b: number }) {
  return r >= 0 && r <= 1 && g >= 0 && g <= 1 && b >= 0 && b <= 1
}

function oklchToSrgbHex(oklch: OklchColor): HexColor {
  const direct = oklchToRgb(oklch)
  if (isSrgbColor(direct)) return rgbToHex(direct.r, direct.g, direct.b)

  let lowerChroma = 0
  let upperChroma = oklch.c
  let mapped = oklchToRgb({ ...oklch, c: lowerChroma })

  for (let attempt = 0; attempt < 12; attempt++) {
    const chroma = (lowerChroma + upperChroma) / 2
    const candidate = oklchToRgb({ ...oklch, c: chroma })
    if (isSrgbColor(candidate)) {
      lowerChroma = chroma
      mapped = candidate
      continue
    }
    upperChroma = chroma
  }

  return rgbToHex(mapped.r, mapped.g, mapped.b)
}

const CATEGORICAL_LIGHTNESS_OFFSETS = [0, 0.07, -0.06, 0.04, -0.03, 0.09, -0.08, 0.06, -0.04]
const GOLDEN_ANGLE = 137.507764

export function generateCategoricalPalette(seed: HexColor, isDark: boolean): HexColor[] {
  const base = hexToOklch(seed)
  const baseLightness = isDark ? 0.72 : 0.58
  const chroma = Math.max(0.1, Math.min(base.c, 0.16))

  return CATEGORICAL_LIGHTNESS_OFFSETS.map((lightnessOffset, index) =>
    oklchToSrgbHex({
      l: baseLightness + lightnessOffset,
      c: chroma,
      h: (base.h + GOLDEN_ANGLE * index) % 360,
    }),
  )
}

export function generateNeutralScale(seed: HexColor, isDark: boolean): HexColor[] {
  const base = hexToOklch(seed)
  const scale: HexColor[] = []
  const neutralChroma = Math.min(base.c, 0.02)

  const lightSteps = isDark
    ? [0.13, 0.16, 0.2, 0.24, 0.28, 0.33, 0.4, 0.52, 0.58, 0.66, 0.82, 0.96]
    : [0.995, 0.98, 0.96, 0.94, 0.91, 0.88, 0.84, 0.78, 0.62, 0.56, 0.46, 0.2]

  for (let i = 0; i < 12; i++) {
    scale.push(
      oklchToHex({
        l: lightSteps[i],
        c: neutralChroma,
        h: base.h,
      }),
    )
  }

  return scale
}

export function mixColors(color1: HexColor, color2: HexColor, amount: number): HexColor {
  const c1 = hexToOklch(color1)
  const c2 = hexToOklch(color2)

  return oklchToHex({
    l: c1.l + (c2.l - c1.l) * amount,
    c: c1.c + (c2.c - c1.c) * amount,
    h: c1.h + (c2.h - c1.h) * amount,
  })
}

export function lighten(color: HexColor, amount: number): HexColor {
  const oklch = hexToOklch(color)
  return oklchToHex({
    ...oklch,
    l: Math.min(1, oklch.l + amount),
  })
}

export function darken(color: HexColor, amount: number): HexColor {
  const oklch = hexToOklch(color)
  return oklchToHex({
    ...oklch,
    l: Math.max(0, oklch.l - amount),
  })
}

export function withAlpha(color: HexColor, alpha: number): HexColor {
  const { r, g, b } = hexToRgb(color)
  const opaque = rgbToHex(r, g, b)
  const alphaHex = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, "0")
  return `${opaque}${alphaHex}` as HexColor
}
