import { expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { appFonts, fontStyles } from "../src/fonts"

function faces(css: string) {
  const dom = new JSDOM(`<style>${css}</style>`)
  try {
    return Array.from(dom.window.document.styleSheets[0]!.cssRules).map((rule) => {
      const style = (rule as CSSFontFaceRule).style
      return {
        family: style.getPropertyValue("font-family"),
        weight: style.getPropertyValue("font-weight"),
        source: style.getPropertyValue("src"),
        display: style.getPropertyValue("font-display"),
      }
    })
  } finally {
    dom.window.close()
  }
}

test("active font faces resolve to packaged WOFF2 assets with local fallbacks", async () => {
  const result = faces(fontStyles())
  expect(result.map(({ family, weight }) => [family, weight])).toEqual([
    ['"Inter"', "100 900"],
    ['"IBM Plex Mono"', "400"],
    ['"IBM Plex Mono"', "500"],
    ['"IBM Plex Mono"', "700"],
    ['"Inter Fallback"', ""],
    ['"IBM Plex Mono Fallback"', ""],
  ])
  for (const [index, font] of appFonts.entries()) {
    expect(await Bun.file(font.source).slice(0, 4).text()).toBe("wOF2")
    expect(result[index]!.source).toBe(`url("${font.source}") format("woff2")`)
    expect(result[index]!.display).toBe("swap")
  }
  expect(result.slice(4).map((face) => face.source)).toEqual(['local("Arial")', 'local("Courier New")'])
})

test("standalone font sources can be remapped without changing the host faces", () => {
  const original = faces(fontStyles())
  const resolved = new Map<string, string>()
  const exported = faces(
    fontStyles((source) => {
      const url = `https://fonts.example.test/${resolved.size}.woff2`
      resolved.set(source, url)
      return url
    }),
  )
  expect([...resolved.keys()]).toEqual(appFonts.map((font) => font.source))
  expect(exported.slice(0, 4).map((face) => face.source)).toEqual(
    [0, 1, 2, 3].map((index) => `url("https://fonts.example.test/${index}.woff2") format("woff2")`),
  )
  expect(exported.map(({ source, ...face }) => face)).toEqual(original.map(({ source, ...face }) => face))
  expect(exported.slice(4)).toEqual(original.slice(4))
  expect(faces(fontStyles())).toEqual(original)
})
