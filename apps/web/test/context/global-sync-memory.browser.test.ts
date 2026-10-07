import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../support/browser-fixture"
import type {} from "../fixtures/context/scope-memory"

test("evicted Scope content callbacks release their entire retained store", async () => {
  const directory = await mkdtemp(path.join(import.meta.dir, ".scope-memory-"))
  const services = path.join(directory, "services.tsx")
  await Bun.write(services, Bun.file(path.resolve(import.meta.dir, "../fixtures/context/scope-memory-services.tsx")))
  const fixtureEntry = path.resolve(import.meta.dir, "../fixtures/context/scope-memory.tsx")
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.ts"></script>',
  )
  await Bun.write(
    path.join(directory, "main.ts"),
    `import { mountScopeMemoryFixture } from ${JSON.stringify(fixtureEntry)}; mountScopeMemoryFixture(document.getElementById("root"));`,
  )
  let fixture: BrowserFixture | undefined
  let snapshot: (() => Promise<void>) | undefined
  const browser = await chromium.launch({ headless: true })
  const samples: Array<{ stage: string; markers: number; heapBytes: number; nodes: number; listeners: number }> = []
  try {
    fixture = await createBrowserFixture({
      root: directory,
      aliases: [
        ...[
          "./global-sdk",
          "./locale-config-reconciler",
          "../pages/fatal-error",
          "@/components/dialog/dialog-select-server",
          "@/components/performance/browser-metrics",
          "@ericsanchezok/synergy-sdk/client",
          "@ericsanchezok/synergy-ui/toast",
          "@ericsanchezok/synergy-ui/context/dialog",
        ].map((find) => ({ find, replacement: services })),
        { find: "@", replacement: path.resolve(import.meta.dir, "../../src") },
      ],
    })
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto(fixture.url)
    await page.waitForFunction(() => !!window.__scopeMemoryFixture)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send("HeapProfiler.enable")
    await cdp.send("Performance.enable")
    snapshot = async () => {
      const output = process.env.SYNERGY_BROWSER_HEAP_SNAPSHOT
      if (!output) return
      const chunks: string[] = []
      const chunk = (event: { chunk: string }) => chunks.push(event.chunk)
      cdp.on("HeapProfiler.addHeapSnapshotChunk", chunk)
      try {
        await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false })
        await Bun.write(output, chunks.join(""))
      } finally {
        cdp.off("HeapProfiler.addHeapSnapshotChunk", chunk)
      }
    }
    const sample = async (stage: string) => {
      await cdp.send("HeapProfiler.collectGarbage")
      const objectGroup = `scope-memory-${stage}`
      try {
        const prototype = await cdp.send("Runtime.evaluate", {
          expression: "window.__scopeMemoryPrototype",
          objectGroup,
        })
        const objects = await cdp.send("Runtime.queryObjects", {
          prototypeObjectId: prototype.result.objectId!,
          objectGroup,
        })
        const length = await cdp.send("Runtime.callFunctionOn", {
          objectId: objects.objects.objectId!,
          functionDeclaration: "function() { return this.length }",
          returnByValue: true,
        })
        const performance = await cdp.send("Performance.getMetrics")
        const heap = performance.metrics.find((metric) => metric.name === "JSHeapUsedSize")
        if (!heap) throw new Error("Chromium did not expose its JavaScript heap measurement")
        const dom = await cdp.send("Memory.getDOMCounters")
        const measurement = {
          stage,
          markers: Number(length.result.value),
          heapBytes: heap.value,
          nodes: dom.nodes,
          listeners: dom.jsEventListeners,
        }
        samples.push(measurement)
        return measurement
      } finally {
        await cdp.send("Runtime.releaseObjectGroup", { objectGroup })
      }
    }
    expect((await sample("baseline")).markers).toBe(0)
    for (let batch = 0; batch < 3; batch++) {
      const state = await page.evaluate((batch) => window.__scopeMemoryFixture.churn(batch, 16), batch)
      const current = await sample(`churn-${batch}`)
      expect(state.scopes).toBe(8)
      expect(current.markers).toBe(8)
      expect(state.bytes).toBe(8 * 12 * 2)
    }
    await page.evaluate(() => window.__scopeMemoryFixture.dispose())
    expect((await sample("disposed")).markers).toBe(0)
    expect(errors).toEqual([])
  } finally {
    console.info("scope-memory-profile", JSON.stringify(samples))
    if (process.env.SYNERGY_BROWSER_HEAP_OUTPUT)
      await Bun.write(process.env.SYNERGY_BROWSER_HEAP_OUTPUT, JSON.stringify(samples))
    await snapshot?.()
    await browser.close()
    await fixture?.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 120000)
