import { expect, test } from "bun:test"
import { scopePluginCSS } from "../src/lib/ui-css"

test("scopes nested selectors and names animation/font definitions with their references", () => {
  const css = scopePluginCSS(
    `
    @font-face { font-family: "Demo Font"; src: url("./demo.woff2") }
    @keyframes enter { from { opacity: 0 } to { opacity: 1 } }
    @media (min-width: 40rem) { .card, :scope > button { animation: enter 1s ease; font-family: "Demo Font", sans-serif; background: url("./texture.png") } }
  `,
    "demo",
  )
  expect(css).toContain('@scope ([data-plugin-ui="demo"]) to ([data-plugin-ui])')
  expect(css).toContain("@keyframes p_64656d6f_enter")
  expect(css).toContain("animation:p_64656d6f_enter 1s ease")
  expect(css).toContain('font-family:"p_64656d6f_Demo Font"')
  expect(css).toContain("url(./demo.woff2)")
  expect(css).toContain("url(./texture.png)")
})

test("rejects host selectors, unprocessed imports, remote assets and unsupported global rules", () => {
  for (const css of [
    "body { display:none }",
    ":is(.x,html) { display:none }",
    ":root { --x:1 }",
    '@import "remote.css";',
    "@page { margin:0 }",
    ".x { background:url(https://example.test/a.png) }",
    '@property --host { syntax:"*"; inherits:true }',
  ]) {
    expect(() => scopePluginCSS(css, "demo")).toThrow()
  }
  expect(() => scopePluginCSS(".x { --accent: var(--text-base); color:var(--accent) }", "demo")).not.toThrow()
})
