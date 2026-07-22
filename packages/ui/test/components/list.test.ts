import { describe, expect, test } from "bun:test"

const listSource = await Bun.file(new URL("../../src/components/list.tsx", import.meta.url)).text()
const listStyles = await Bun.file(new URL("../../src/components/list.css", import.meta.url)).text()

describe("List component contract", () => {
  test("supports non-interactive rows without button semantics", () => {
    expect(listSource).toContain("interactive?: boolean")
    expect(listSource).toContain("const interactive = () => props.interactive ?? true")
    expect(listSource).toContain('data-interactive="false"')
    expect(listSource).toContain("<div")
    expect(listSource).toContain('data-interactive="true"')
    expect(listSource).toContain("<button")
    expect(listStyles).toContain('&[data-interactive="false"]:active')
    expect(listStyles).toContain("background: transparent")
  })
})
