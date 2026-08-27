import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"

let browser: Browser
let page: Page

beforeAll(async () => {
  const css = await Bun.file(path.resolve(import.meta.dir, "../../src/components/activity-trace.css")).text()
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 640, height: 600 } })
  await page.setContent(`
    <style>
      :root {
        --surface-base-hover: rgb(38 38 40);
        --surface-raised-base: rgb(28 28 30);
        --text-base: rgb(240 240 242);
        --text-weak: rgb(184 184 190);
        --text-subtle: rgb(144 144 150);
        --icon-weak-base: rgb(152 152 158);
        --radius-sm: 6px;
      }
      ${css}
    </style>
    <div id="trace" data-component="activity-trace" style="width: 440px; margin: 0">
      <ol data-slot="activity-step-list">
        <li data-slot="activity-step" data-family="delegate" data-state="done">
          <button data-slot="activity-step-trigger" type="button">
            <span data-slot="activity-step-icon" aria-hidden="true"><svg width="16" height="16"></svg></span>
            <div data-slot="activity-step-copy">
              <span data-slot="activity-step-family">Delegated</span>
              <span data-slot="activity-step-title">Call subagent Add synergy-config pointer rows and strengthen three repo dev skills</span>
              <span data-slot="activity-step-subtitle">Add synergy-config pointer rows</span>
            </div>
            <span data-slot="activity-state" data-state="done">Done</span>
          </button>
        </li>
      </ol>
      <div data-component="activity-receipt">
        <div data-slot="activity-receipt-row">
          <span data-slot="activity-receipt-icon" aria-hidden="true"><svg width="16" height="16"></svg></span>
          <span data-slot="activity-receipt-title">Coordinated Update DAG and then run the parallel dependent branch work</span>
          <span data-slot="activity-state" data-state="done">Done</span>
        </div>
      </div>
    </div>
  `)
})

afterAll(async () => {
  await browser?.close()
})

describe("activity trace narrow layout", () => {
  test("long step titles stay inside the trace container", async () => {
    const metrics = await page.evaluate(() => {
      const trace = document.querySelector<HTMLElement>("#trace")!
      const title = document.querySelector<HTMLElement>('[data-slot="activity-step-title"]')!
      return {
        traceRight: trace.getBoundingClientRect().right,
        titleRight: title.getBoundingClientRect().right,
        titleScrollWidth: title.scrollWidth,
        titleClientWidth: title.clientWidth,
      }
    })

    expect(metrics.titleRight).toBeLessThanOrEqual(metrics.traceRight + 1)
    expect(metrics.titleScrollWidth).toBeGreaterThan(metrics.titleClientWidth)
  })

  test("long receipt titles stay inside the trace container", async () => {
    const metrics = await page.evaluate(() => {
      const trace = document.querySelector<HTMLElement>("#trace")!
      const title = document.querySelector<HTMLElement>('[data-slot="activity-receipt-title"]')!
      return {
        traceRight: trace.getBoundingClientRect().right,
        titleRight: title.getBoundingClientRect().right,
        titleScrollWidth: title.scrollWidth,
        titleClientWidth: title.clientWidth,
      }
    })

    expect(metrics.titleRight).toBeLessThanOrEqual(metrics.traceRight + 1)
    expect(metrics.titleScrollWidth).toBeGreaterThan(metrics.titleClientWidth)
  })
})
