import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { chromium, type Browser } from "playwright"

const css = await readFile(new URL("../../../src/components/sidebar/sidebar.css", import.meta.url), "utf8")
let browser: Browser

beforeAll(async () => {
  browser = await chromium.launch({ headless: true })
})

afterAll(async () => {
  await browser.close()
})

describe("channel sidebar hierarchy", () => {
  test("indents Clarus Projects and Sessions like Feishu partners and Sessions", async () => {
    const page = await browser.newPage({ viewport: { width: 320, height: 300 } })
    try {
      await page.setContent(`
        <style>*, ::before, ::after { box-sizing: border-box; } ${css}</style>
        <div class="sb-root-section">
          <div class="sb-channel-account-group" data-provider="feishu">
            <div class="sb-session-group-header">Feishu</div>
            <div class="sb-channel-partner-group">
              <div class="sb-session-group-header" data-child-row>Partner</div>
              <div class="sb-sessions">
                <div class="sb-session-row" data-session-row>Session</div>
              </div>
            </div>
          </div>
          <div class="sb-channel-account-group" data-provider="clarus">
            <div class="sb-session-group-header">Clarus</div>
            <div class="sb-channel-managed-projects">
              <div class="sb-project-group">
                <div class="sb-project-row" data-child-row>Project</div>
                <div class="sb-sessions">
                  <div class="sb-session-row" data-session-row>Session</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      `)

      const hierarchyInsets = await page.locator(".sb-channel-account-group").evaluateAll((providers) =>
        providers.map((provider) => {
          const childRow = provider.querySelector<HTMLElement>("[data-child-row]")
          const sessionRow = provider.querySelector<HTMLElement>("[data-session-row]")
          if (!childRow || !sessionRow) throw new Error("Expected Channel child and Session rows")
          const providerLeft = provider.getBoundingClientRect().left
          return {
            child: childRow.getBoundingClientRect().left - providerLeft,
            session: sessionRow.getBoundingClientRect().left - providerLeft,
          }
        }),
      )

      expect(hierarchyInsets).toEqual([
        { child: 12, session: 32 },
        { child: 12, session: 32 },
      ])
    } finally {
      await page.close()
    }
  })
})
