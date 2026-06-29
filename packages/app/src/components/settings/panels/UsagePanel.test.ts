import { describe, expect, test } from "bun:test"

const usagePanel = await Bun.file(new URL("./UsagePanel.tsx", import.meta.url)).text()
const settingsCss = await Bun.file(new URL("../settings-panel.css", import.meta.url)).text()

describe("Usage panel UI contract", () => {
  test("keeps refresh inside the content flow instead of the page header", () => {
    expect(usagePanel).toContain("usage-overview")
    expect(usagePanel).toContain("usage-page-shell")
    expect(usagePanel).not.toContain("actions={")
  })

  test("uses human-facing quota window labels and values", () => {
    expect(usagePanel).toContain("formatUsageWindowLabel(window.label)")
    expect(usagePanel).toContain("\"5-hour window\"")
    expect(usagePanel).toContain("formatPercent(window.remainingPercent)")
    expect(usagePanel).toContain("remaining")
    expect(usagePanel).not.toContain("<div class=\"usage-window-label\">{window.label}</div>")
  })

  test("renders compact usage rows with a meter instead of distant label-value pairs", () => {
    expect(usagePanel).toContain("usage-window-meter")
    expect(settingsCss).toContain(".ds-content-inner:has(> .usage-page-shell)")
    expect(settingsCss).toContain("grid-template-columns: minmax(150px, 1fr) minmax(120px, 170px)")
    expect(settingsCss).toContain(".usage-window-meter span")
  })
})
