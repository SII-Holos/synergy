import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { resourceDisplay } from "../src/components/resource-display"
import { siteIcon, siteIconHosts } from "../src/components/site-icons/model"
import { iconNames } from "../src/components/site-icons/types"

const components = path.resolve(import.meta.dir, "../src/components")
const assetDirectory = path.resolve(import.meta.dir, "../src/assets/icons/site")
const sprite = readFileSync(path.join(components, "site-icons/sprite.svg"), "utf8")
const symbols = new Set([...sprite.matchAll(/<symbol[^>]*\sid="([^"]+)"/g)].map((match) => match[1]!))
const marks = readdirSync(assetDirectory).filter((name) => name.endsWith(".svg"))

const channel = (value: number) =>
  value / 255 <= 0.04045 ? value / 255 / 12.92 : ((value / 255 + 0.055) / 1.055) ** 2.4
const luminance = (hex: string) => {
  const [red, green, blue] = [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16))
  return 0.2126 * channel(red!) + 0.7152 * channel(green!) + 0.0722 * channel(blue!)
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((left, right) => right - left)
  return (hi + 0.05) / (lo + 0.05)
}
// --surface-base in the two shipped themes (packages/ui/src/styles/theme.generated.css).
const SURFACES = ["FFFFFF", "242424"]

describe("site brand marks", () => {
  test("the sprite and the generated type describe the same icon set", () => {
    expect([...symbols].sort()).toEqual([...iconNames].sort())
    expect(marks.map((name) => name.replace(/\.svg$/, "")).sort()).toEqual([...iconNames].sort())
  })

  test("every registered host resolves to a symbol that exists", () => {
    const unresolved = Object.entries(siteIconHosts).filter(([, icon]) => !symbols.has(icon))
    expect(unresolved).toEqual([])
  })

  test("every symbol is reachable from a registered host", () => {
    const reachable = new Set<string>(Object.values(siteIconHosts))
    expect([...symbols].filter((name) => !reachable.has(name))).toEqual([])
  })

  test("subdomains inherit the mark registered on their parent domain", () => {
    expect(siteIcon("en.wikipedia.org")).toBe("wikipedia")
    expect(siteIcon("www.notion.so")).toBe("notion")
    expect(siteIcon("app.notion.com")).toBe("notion")
    expect(siteIcon("api.github.com")).toBe("github")
  })

  test("a lookalike host cannot borrow a mark", () => {
    for (const host of [
      "github.example.org",
      "github.com.example.org",
      "github.com.evil.test",
      "notgithub.com",
      "arxiv.org.evil.test",
      "example.org",
      "com",
    ])
      expect({ host, icon: siteIcon(host) }).toEqual({ host, icon: undefined })
  })

  test("host matching ignores case and a trailing root dot", () => {
    expect(siteIcon("GITHUB.COM")).toBe("github")
    expect(siteIcon("arxiv.org.")).toBe("arxiv")
  })

  test("each mark stays legible on both theme surfaces", () => {
    const illegible = marks.flatMap((name) => {
      const fill = readFileSync(path.join(assetDirectory, name), "utf8").match(/fill="([^"]+)"/)?.[1]
      if (!fill || fill === "currentColor") return []
      const hex = fill.replace("#", "")
      const worst = Math.min(...SURFACES.map((surface) => contrast(hex, surface)))
      return worst >= 3 ? [] : [{ name, fill, worst: Number(worst.toFixed(2)) }]
    })
    expect(illegible).toEqual([])
  })

  test("marks their owner draws in black follow the surrounding text color", () => {
    // A chromatic fill here would misrepresent a wordmark whose identity is its
    // silhouette, so the vendoring rule pins these to currentColor.
    for (const name of ["github", "notion", "rust", "vercel", "wikipedia", "x"]) {
      const fill = readFileSync(path.join(assetDirectory, `${name}.svg`), "utf8").match(/fill="([^"]+)"/)?.[1]
      expect({ name, fill }).toEqual({ name, fill: "currentColor" })
    }
  })

  test("resource display prefers a brand mark and never emits both visuals", () => {
    const branded = resourceDisplay({ kind: "url", url: "https://arxiv.org/abs/2412.09764" })
    expect(branded.site).toBe("arxiv")
    expect(branded.icon).toBeUndefined()

    const neutral = resourceDisplay({ kind: "url", url: "https://example.org/docs" })
    expect(neutral.site).toBeUndefined()
    expect(neutral.icon).toBe("browser.main")
  })
})
