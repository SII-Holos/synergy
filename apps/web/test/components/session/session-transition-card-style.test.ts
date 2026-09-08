import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"

const css = await Bun.file(
  path.resolve(import.meta.dir, "../../../src/components/session/session-transition-card.css"),
).text()

let browser: Browser
let page: Page

beforeAll(async () => {
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  await page.setContent(`
    <style>
      :root {
        --workbench-card-bg: rgb(28 28 30);
        --border-base: rgb(60 60 64);
        --surface-inset-base: rgb(24 24 26);
        --surface-inset-base-hover: rgb(34 34 38);
        --surface-success-weak: rgb(24 46 34);
        --icon-success-base: rgb(74 189 120);
        --text-on-success-base: rgb(126 217 168);
        --text-strong: rgb(240 240 242);
        --text-base: rgb(240 240 242);
        --text-weak: rgb(184 184 190);
        --text-weaker: rgb(144 144 150);
        --icon-base: rgb(220 220 226);
        --icon-weak: rgb(152 152 158);
        --font-family-sans: sans-serif;
      }
      ${css}
    </style>
    <div class="session-transition-card" data-kind="new-worktree-session" data-phase="success">
      <div class="session-transition-card-header">
        <span class="session-transition-card-icon" data-state="success">✓</span>
        <div class="session-transition-card-heading">
          <span class="session-transition-card-kicker">Worktree session</span>
          <span class="session-transition-card-title">Worktree session request accepted</span>
          <span class="session-transition-card-description">The workspace is ready and your first message is queued for processing.</span>
        </div>
        <button type="button" class="session-transition-card-dismiss">×</button>
      </div>
      <div class="session-transition-step-list">
        <div class="session-transition-step-row" data-state="complete">
          <span class="session-transition-step-icon" data-state="complete">✓</span>
          <div class="session-transition-step-copy">
            <span class="session-transition-step-title">Prepare session</span>
            <span class="session-transition-step-detail">Conversation state is ready.</span>
          </div>
          <span class="session-transition-step-status">Done</span>
        </div>
        <div class="session-transition-step-row" data-state="complete">
          <span class="session-transition-step-icon" data-state="complete">✓</span>
          <div class="session-transition-step-copy">
            <span class="session-transition-step-title">Create checkout</span>
            <span class="session-transition-step-detail">Workspace setup complete.</span>
          </div>
          <span class="session-transition-step-status">Done</span>
        </div>
      </div>
    </div>
  `)
})

afterAll(async () => {
  await browser?.close()
})

describe("session transition card lightness", () => {
  test("uses the card surface instead of the modal surface", async () => {
    const background = await page
      .locator(".session-transition-card")
      .evaluate((element) => getComputedStyle(element).backgroundColor)
    expect(background).toBe("rgb(28, 28, 30)")
  })

  test("keeps the card radius aligned with the product surface language", async () => {
    const radius = await page
      .locator(".session-transition-card")
      .evaluate((element) => getComputedStyle(element).borderRadius)
    expect(radius).toBe("14px")
  })

  test("keeps the header icon small enough for an inline card", async () => {
    const size = await page.locator(".session-transition-card-icon").evaluate((element) => {
      const style = getComputedStyle(element)
      return { width: style.width, height: style.height }
    })
    expect(size).toEqual({ width: "28px", height: "28px" })
  })

  test("keeps step rows at a compact density", async () => {
    const row = await page
      .locator(".session-transition-step-row")
      .first()
      .evaluate((element) => getComputedStyle(element).minHeight)
    const icon = await page
      .locator(".session-transition-step-icon")
      .first()
      .evaluate((element) => {
        const style = getComputedStyle(element)
        return { width: style.width, height: style.height }
      })
    expect(row).toBe("44px")
    expect(icon).toEqual({ width: "22px", height: "22px" })
  })
})
