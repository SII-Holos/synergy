import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { chromium, type Browser } from "playwright"

const execution = await readFile(new URL("../../../src/components/execution/execution.css", import.meta.url), "utf8")
let browser: Browser
beforeAll(async () => {
  browser = await chromium.launch({ headless: true })
})
afterAll(async () => {
  await browser.close()
})

for (const width of [375, 426]) {
  test("a narrow inspector puts reading before global controls at " + width + "px", async () => {
    const page = await browser.newPage({ viewport: { width, height: 946 } })
    try {
      await page.setContent(`<style>*{box-sizing:border-box}body{margin:0}${execution}</style>
        <div class="execution-panel execution-panel--inspecting" style="height:946px">
          <div class="execution-global"><div class="execution-panel-toolbar">Round</div><section class="execution-overview">Metrics and chart</section><div class="execution-filters">Search and filters</div></div>
          <div class="execution-workspace"><div class="execution-trajectory-pane">Task process</div><section class="execution-inspector">
            <div class="execution-inspector-header"><button class="execution-back">Back</button><div class="execution-inspector-title"><strong>Read file</strong><small>Tool · completed</small></div></div>
            <nav class="execution-tabs"><button>Result</button><button>Input</button><button>Timing</button></nav>
            <div class="execution-reader"><div class="execution-reader-toolbar"><button>Copy JSON</button></div><div class="execution-content-viewport"><pre class="execution-content-row">First line of the actual result</pre></div></div>
          </section></div>
        </div>`)
      const result = await page.locator(".execution-content-row").evaluate((element) => ({
        top: element.getBoundingClientRect().top,
        size: getComputedStyle(element).fontSize,
        overflow: document.documentElement.scrollWidth > innerWidth,
      }))
      expect(await page.locator(".execution-global").isVisible()).toBe(false)
      expect(await page.locator(".execution-trajectory-pane").isVisible()).toBe(false)
      expect(result.top).toBeLessThanOrEqual(160)
      expect(result.size).toBe("14px")
      expect(result.overflow).toBe(false)
    } finally {
      await page.close()
    }
  })
}

test("wide inspection allocates forty percent to the process and left aligns field values", async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 946 } })
  try {
    await page.setContent(
      `<style>*{box-sizing:border-box}body{margin:0}${execution}</style><div class="execution-panel execution-panel--inspecting" style="height:946px"><div class="execution-workspace"><div class="execution-trajectory-pane">Process</div><section class="execution-inspector"><dl class="execution-detail-rows"><div><dt>Start</dt><dd>12:30</dd></div></dl></section></div></div>`,
    )
    expect((await page.locator(".execution-trajectory-pane").boundingBox())?.width).toBeCloseTo(400, 0)
    expect(await page.locator("dd").evaluate((element) => getComputedStyle(element).textAlign)).toBe("left")
  } finally {
    await page.close()
  }
})
