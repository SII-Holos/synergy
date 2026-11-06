import inter from "./assets/fonts/inter.woff2"
import regular from "./assets/fonts/BlexMonoNerdFontMono-Regular.woff2"
import medium from "./assets/fonts/BlexMonoNerdFontMono-Medium.woff2"
import bold from "./assets/fonts/BlexMonoNerdFontMono-Bold.woff2"

export const appFonts = [
  { family: "Inter", weight: "100 900", source: inter },
  { family: "IBM Plex Mono", weight: "400", source: regular },
  { family: "IBM Plex Mono", weight: "500", source: medium },
  { family: "IBM Plex Mono", weight: "700", source: bold },
]

export function fontStyles(resolve: (source: string) => string = (source) => source) {
  return (
    appFonts
      .map(
        (font) =>
          `@font-face { font-family: "${font.family}"; src: url("${resolve(font.source)}") format("woff2"); font-display: swap; font-style: normal; font-weight: ${font.weight}; }`,
      )
      .join("\n") +
    `
    @font-face { font-family: "Inter Fallback"; src: local("Arial"); size-adjust: 100%; ascent-override: 97%; descent-override: 25%; line-gap-override: 1%; }
    @font-face { font-family: "IBM Plex Mono Fallback"; src: local("Courier New"); size-adjust: 100%; ascent-override: 97%; descent-override: 25%; line-gap-override: 1%; }
  `
  )
}
