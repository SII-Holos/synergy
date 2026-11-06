import { resolveSkinAppearance, type Skin } from "@ericsanchezok/synergy-plugin/skin"

export function skinStyles(input: {
  id: string
  skin: Skin
  assets: Readonly<Record<string, string>>
  mode: "light" | "dark"
  narrow: boolean
  reducedMotion: boolean
  customFonts: { sans: boolean; mono: boolean }
}) {
  const appearance = resolveSkinAppearance(input.skin, input.mode, input.narrow)
  const scope = `[data-skin-root=${JSON.stringify(input.id)}]`
  const fontPrefix = `synergy-skin-${Array.from(input.id, (char) => char.codePointAt(0)!.toString(16)).join("-")}`
  const css: string[] = []
  const url = (id: string) => {
    const asset = input.assets[id]
    if (!asset) throw new Error(`Skin asset ${id} is unavailable`)
    return `url(${JSON.stringify(asset)})`
  }
  const typography: string[] = []
  for (const kind of ["sans", "mono"] as const) {
    const id = appearance.typography?.[kind]
    if (!id || input.customFonts[kind]) continue
    const asset = input.skin.assets[id]
    if (asset?.kind !== "font") throw new Error(`Skin font ${id} is unavailable`)
    const family = `${fontPrefix}-${id}`
    css.push(
      `@font-face{font-family:"${family}";src:${url(id)};font-weight:${asset.weight};font-style:${asset.style};font-display:swap}`,
    )
    typography.push(`--font-family-${kind}:"${family}",${kind === "mono" ? "monospace" : "sans-serif"}`)
  }
  css.push(
    `${scope}{${typography.join(";")};font-family:var(--font-family-sans);--skin-control-gap:${appearance.density === "compact" ? 4 : 8}px}`,
  )
  css.push(`${scope} [data-ui-part="toolbar"]{gap:var(--skin-control-gap)}`)
  for (const [part, material] of Object.entries(appearance.parts)) {
    if (!material) continue
    const selector = `${scope} [data-ui-part=${JSON.stringify(part)}]`
    const styles = ["isolation:isolate"]
    if (material.radius !== undefined) styles.push(`border-radius:${material.radius}px`)
    if (material.borderWidth !== undefined) styles.push(`border:${material.borderWidth}px solid var(--border-base)`)
    if (material.shadow)
      styles.push(
        `box-shadow:${material.shadow === "none" ? "none" : `var(--shadow-${material.shadow === "soft" ? "sm" : "lg"})`}`,
      )
    const background = material.background
    const decoration = material.decoration
    if (background || decoration) styles.push("position:relative")
    css.push(`${selector}{${styles.join(";")}}`)
    if (background)
      css.push(
        `${selector}::before{content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;border-radius:inherit;background-image:${url(background.asset)};background-size:${background.fit};background-repeat:${background.repeat};background-position:${background.x}% ${background.y}%;opacity:${background.opacity}}`,
      )
    if (
      decoration &&
      !(input.narrow && decoration.narrow === "hide") &&
      !(input.reducedMotion && input.skin.reducedMotion.decorations === "hide")
    ) {
      const [vertical, horizontal] = decoration.anchor.split("-")
      css.push(
        `${selector}::after{content:"";position:absolute;${vertical}:0;${horizontal}:0;width:${decoration.width}%;height:${decoration.height}%;z-index:-1;pointer-events:none;background-image:${url(decoration.asset)};background-size:contain;background-repeat:no-repeat;background-position:${horizontal} ${vertical};opacity:${decoration.opacity}}`,
      )
    }
  }
  return css.join("\n")
}
