import { describe, expect, test } from "bun:test"

const html = await Bun.file(new URL("../index.html", import.meta.url)).text()
const entry = await Bun.file(new URL("./entry.tsx", import.meta.url)).text()

function blockBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  const endIndex = source.indexOf(end, startIndex)
  expect(endIndex).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex + end.length)
}

describe("app boot shell", () => {
  test("keeps the static boot surface outside the Solid root", () => {
    const bootIndex = html.indexOf('id="synergy-app-boot"')
    const rootIndex = html.indexOf('id="root"')

    expect(bootIndex).toBeGreaterThanOrEqual(0)
    expect(rootIndex).toBeGreaterThanOrEqual(0)
    expect(bootIndex).toBeLessThan(rootIndex)

    const rootBlock = blockBetween(html, '<div id="root"', "</div>")
    expect(rootBlock).not.toContain("synergy-app-boot")
  })

  test("uses literal fallback surfaces before app CSS loads", () => {
    const style = blockBetween(html, '<style id="synergy-app-boot-style">', "</style>")

    expect(style).toContain("#f7f7f5")
    expect(style).toContain("#111214")
    expect(style).toContain("#synergy-app-boot")
    expect(style).not.toContain("--background-base")
    expect(style).not.toContain("var(")
  })

  test("gates temporary desktop chrome on the desktop bridge", () => {
    expect(html).toContain("window.synergyDesktop && window.synergyDesktop.window")
    expect(html).toContain('html[data-synergy-desktop-chrome="custom"] .synergy-app-boot-chrome--custom')
    expect(html).toContain('html[data-synergy-desktop-chrome="native"] .synergy-app-boot-chrome--native')
    expect(html).toContain('data-synergy-app-boot-window-action="minimize"')
    expect(html).toContain('data-synergy-app-boot-window-action="maximize"')
    expect(html).toContain('data-synergy-app-boot-window-action="close"')
  })

  test("removes the boot shell only after Solid render is invoked", () => {
    const renderIndex = entry.indexOf("render(")
    const scheduleIndex = entry.lastIndexOf("scheduleBootShellRemoval()")

    expect(renderIndex).toBeGreaterThanOrEqual(0)
    expect(scheduleIndex).toBeGreaterThan(renderIndex)
    expect(entry).toContain('document.getElementById("synergy-app-boot")?.remove()')
    expect(entry).toContain("window.requestAnimationFrame(remove)")
  })
})
