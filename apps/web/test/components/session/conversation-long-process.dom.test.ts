import { expect, test } from "bun:test"
import { page, url, frames, browser, fixtureServer, observeResizeErrors } from "../../support/conversation-process"

test.each([false, true])(
  "late evidence above expanded process reading settles before paint (paged=%s)",
  async (paged) => {
    await page.goto(`${url}?scrolling&history-controls`)
    await page.getByText("I will check the project first.", { exact: true }).waitFor()
    if (paged) await page.getByRole("button", { name: "Load earlier messages", exact: true }).click()
    await page.evaluate(() => window.__conversationProcess.grow(1000))
    expect(await page.evaluate(() => window.__conversationProcess.locate("more", "many-400"))).toBe(true)
    await frames()
    await page.waitForFunction(() => !document.querySelector("[data-motion-changing]"))
    const viewport = page.locator('[data-component="process-viewport"]').last()
    await viewport.evaluate((element) => {
      element.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }))
      element.scrollTop -= 1
    })
    await page.waitForTimeout(200)
    await viewport.evaluate((element) => {
      const node = element.querySelector<HTMLElement>('[data-part-id="many-400"]')!
      element.scrollTop += node.getBoundingClientRect().top - element.getBoundingClientRect().top
    })
    await page.waitForTimeout(200)
    const samples = await viewport.evaluate(async (element) => {
      const node = element.querySelector<HTMLElement>('[data-part-id="many-400"]')!
      const top = node.getBoundingClientRect().top
      const samples = []
      await new Promise(requestAnimationFrame)
      window.__conversationProcess.growToolEvidence("many-399")
      for (let frame = 0; frame < 40; frame++) {
        if (frame) await new Promise(requestAnimationFrame)
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        const bounds = element.getBoundingClientRect()
        const rows = [...element.querySelectorAll<HTMLElement>("[data-display-row]")].filter((row) => {
          const rect = row.getBoundingClientRect()
          return row.checkVisibility() && rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom
        })
        samples.push({
          connected: node.isConnected,
          drift: node.getBoundingClientRect().top - top,
          overlap: Math.max(
            0,
            ...rows.slice(1).map((row, i) => rows[i].getBoundingClientRect().bottom - row.getBoundingClientRect().top),
          ),
        })
      }
      return samples
    })
    expect(await viewport.locator('[data-part-id="many-399"] [data-slot="activity-evidence"]').count()).toBe(1)
    expect(samples.every((sample) => sample.connected)).toBe(true)
    expect(Math.max(...samples.map((sample) => Math.abs(sample.drift)))).toBeLessThanOrEqual(2)
    expect(Math.max(...samples.map((sample) => sample.overlap))).toBeLessThanOrEqual(1)
  },
)

test.each([
  { kind: "split", width: 700, mode: "full" },
  { kind: "continuous", width: 700, mode: "full" },
  { kind: "split", width: 375, mode: "full" },
  { kind: "continuous", width: 375, mode: "full" },
  { kind: "split", width: 700, mode: "balanced" },
  { kind: "continuous", width: 700, mode: "balanced" },
  { kind: "split", width: 375, mode: "balanced" },
  { kind: "continuous", width: 375, mode: "balanced" },
] as const)(
  "loading earlier process history preserves expanded content within the current turn (%j)",
  async ({ kind, width, mode }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`${url}?scrolling&history-controls&keep-history-control&process-history=${kind}`)
    await page.getByText("I will check the project first.", { exact: true }).waitFor()
    await page.evaluate((mode) => {
      window.__conversationProcess.reasoning(
        "Check evidence\n\n" + "Detailed evidence remains expanded.\n\n".repeat(30),
        "thought",
      )
      window.__conversationProcess.stream("The final answer stays below the expanded process. ".repeat(120))
      window.__conversationProcess.terminal()
      window.__conversationProcess.mode(mode)
    }, mode)
    const process = page.locator('[data-slot="turn-process-trigger"]').first()
    if ((await process.getAttribute("aria-expanded")) === "false") await process.click()
    const batch = page.locator('[data-slot="activity-batch-trigger"]').first()
    if ((await batch.getAttribute("aria-expanded")) === "false") await batch.click()
    const reasoning = page.locator('[data-part-id="thought"] [data-slot="process-reasoning-trigger"]').first()
    if ((await reasoning.getAttribute("aria-expanded")) !== "true") await reasoning.click()
    await page.getByText("Check evidence", { exact: false }).first().waitFor()
    await page.waitForFunction(() => !document.querySelector("[data-motion-changing]"))
    await page.locator("[data-scroller]").evaluate((v) => {
      v.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }))
      v.scrollTop = 0
    })
    await frames()
    const recording = page.evaluate(async () => {
      const node = document.querySelector<HTMLElement>('[data-reasoning-part="thought"]')!
      const top = node.getBoundingClientRect().top
      const opacity = () => {
        let value = 1
        for (let element: HTMLElement | null = node; element; element = element.parentElement)
          value *= Number(getComputedStyle(element).opacity)
        return value
      }
      const initialOpacity = opacity()
      await new Promise<void>((resolve) =>
        document.querySelector("[data-history-load]")!.addEventListener("click", () => resolve(), { once: true }),
      )
      const samples = []
      for (let frame = 0; frame < 60; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
        samples.push({
          connected: node.isConnected,
          faded: opacity() < initialOpacity - 0.01,
          drift: node.getBoundingClientRect().top - top,
          expanded: document.querySelector('[data-part-id="thought"] [aria-expanded]')?.getAttribute("aria-expanded"),
        })
      }
      return samples
    })
    await page.getByRole("button", { name: "Load earlier messages", exact: true }).click()
    const samples = await recording
    expect(samples.every((sample) => sample.connected && !sample.faded && sample.expanded === "true")).toBe(true)
    expect(Math.max(...samples.map((sample) => Math.abs(sample.drift)))).toBeLessThanOrEqual(2)
    await page.locator("[data-scroller]").evaluate((v) => {
      v.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }))
      v.scrollTop = 0
    })
    const earlierBatch = page.locator('[data-slot="activity-batch-trigger"]').first()
    if ((await earlierBatch.getAttribute("aria-expanded")) === "false") {
      const opening = await earlierBatch.evaluate(async (button) => {
        const viewport = document.querySelector<HTMLElement>("[data-scroller]")!
        ;(button as HTMLButtonElement).click()
        const samples = []
        for (let frame = 0; frame < 45; frame++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
          const bounds = viewport.getBoundingClientRect()
          const rows = [...viewport.querySelectorAll<HTMLElement>("[data-display-row]")].filter(
            (row) =>
              !row.closest('[data-component="process-viewport"]') &&
              row.checkVisibility({ visibilityProperty: true, opacityProperty: true }) &&
              row.getBoundingClientRect().bottom > bounds.top &&
              row.getBoundingClientRect().top < bounds.bottom,
          )
          samples.push({
            rows: rows.length,
            overlap: Math.max(
              0,
              ...rows
                .slice(1)
                .map((row, i) => rows[i].getBoundingClientRect().bottom - row.getBoundingClientRect().top),
            ),
          })
        }
        return samples
      })
      expect(opening.every((sample) => sample.rows > 0)).toBe(true)
      expect(Math.max(...opening.map((sample) => sample.overlap))).toBeLessThanOrEqual(1)
    }
    const earlier = page.locator('[data-part-id="earlier-thought"] [data-slot="process-reasoning-trigger"]').first()
    if (kind === "continuous") {
      await page.locator('[data-component="process-viewport"]').first().hover()
      await page.mouse.wheel(0, -10000)
    }
    await earlier.waitFor()
    expect(await earlier.getAttribute("aria-expanded")).toBe("false")
    await earlier.click()
    await page.getByText("Earlier reasoning remains available.", { exact: true }).waitFor()
    const opening = await earlier.evaluate(async (trigger) => {
      const body = trigger.closest('[data-part-id="earlier-thought"]')!.querySelector("[data-reasoning-part]")!
      const samples = []
      for (let frame = 0; frame < 30; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
        samples.push({
          retained: body.isConnected && trigger.isConnected,
          open: trigger.getAttribute("aria-expanded") === "true",
          text: body.textContent?.includes("Earlier reasoning remains available."),
        })
      }
      return samples
    })
    expect(opening.every((sample) => sample.retained && sample.open && sample.text)).toBe(true)
  },
  30000,
)

test.each([
  { width: 700, rate: 1, reducedMotion: "no-preference" },
  { width: 375, rate: 4, reducedMotion: "no-preference" },
  { width: 375, rate: 1, reducedMotion: "reduce" },
] as const)(
  "reopening long intermediate prose preserves row geometry and bounded mounts (%j)",
  async (mode) => {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: mode.rate })
    await page.emulateMedia({ reducedMotion: mode.reducedMotion })
    await page.goto(`${url}?outer-paging`)
    await page.waitForFunction(() => !!window.__conversationProcess)
    await page.evaluate((width) => {
      window.__conversationProcess.reading(true)
      document.querySelector<HTMLElement>("[data-scroller]")!.style.width = `${width}px`
      document.querySelector<HTMLElement>("[data-scroller]")!.scrollTop = 0
    }, mode.width)
    const trigger = page.locator('[data-slot="turn-process-trigger"]')
    await trigger.waitFor()
    await page.waitForFunction(() => !document.querySelector("[data-motion-changing]"))
    await trigger.click()
    await page.waitForFunction(() => !document.querySelector("[data-motion-changing]"))
    await frames()
    const trace = await page.evaluate(async () => {
      const frames: { mounted: number; overlap: number; text: string[] }[] = []
      document.querySelector<HTMLButtonElement>('[data-slot="turn-process-trigger"]')!.click()
      for (let frame = 0; frame < 60; frame++) {
        await new Promise(requestAnimationFrame)
        const viewport = document.querySelector("[data-scroller]")!.getBoundingClientRect()
        const rows = [...document.querySelectorAll<HTMLElement>("[data-process-body]")].filter(
          (row) => !row.closest('[data-component="process-viewport"]'),
        )
        const painted = rows.filter((row) => {
          const bounds = row.getBoundingClientRect()
          return (
            bounds.height > 0 &&
            bounds.bottom > viewport.top &&
            bounds.top < viewport.bottom &&
            getComputedStyle(row.parentElement!).visibility !== "hidden" &&
            getComputedStyle(row).opacity !== "0"
          )
        })
        frames.push({
          mounted: rows.length,
          overlap: Math.max(
            0,
            ...painted
              .slice(1)
              .map((row, index) => painted[index].getBoundingClientRect().bottom - row.getBoundingClientRect().top),
          ),
          text: painted.map((row) => row.textContent!.slice(0, 40)),
        })
      }
      return frames
    })
    expect(Math.max(...trace.map((frame) => frame.overlap)), JSON.stringify(trace)).toBeLessThanOrEqual(1)
    expect(Math.max(...trace.map((frame) => frame.mounted))).toBeLessThan(30)
  },
  30000,
)

test("scrolling cold prose keeps accepted rows separate and reuses already read bodies", async () => {
  await page.goto(`${url}?content=long-prose&body-delay=80`)
  await page.waitForFunction(() => !!document.querySelector('[data-part-id="long-0"] [data-component="markdown"]'))
  const result = await page.evaluate(async () => {
    const viewport = document.querySelector<HTMLElement>("[data-scroller]")!
    let overlap = 0
    let mounted = 0
    const acceptedReads: Record<string, number> = {}
    const samples = []
    for (let step = 0; step < 160; step++) {
      viewport.scrollTop += step < 80 ? 100 : -100
      await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
      const bounds = viewport.getBoundingClientRect()
      const rows = [...document.querySelectorAll<HTMLElement>("[data-display-row]")].filter(
        (row) =>
          !row.closest('[data-component="process-viewport"]') &&
          row.getBoundingClientRect().height > 0 &&
          row.getBoundingClientRect().bottom > bounds.top &&
          row.getBoundingClientRect().top < bounds.bottom &&
          getComputedStyle(row.parentElement!).visibility !== "hidden",
      )
      mounted = Math.max(mounted, document.querySelectorAll("[data-display-row]").length)
      for (const row of rows) {
        const id = row.dataset.partId
        if (
          id &&
          !row.hasAttribute("data-content-pending") &&
          row.querySelector('[data-component="markdown"]')?.textContent
        )
          acceptedReads[id] ??= window.__conversationProcess.contentReads(id)
      }
      const gap = Math.max(
        0,
        ...rows
          .slice(1)
          .map((row, index) => rows[index].getBoundingClientRect().bottom - row.getBoundingClientRect().top),
      )
      overlap = Math.max(overlap, gap)
      samples.push({ scroll: viewport.scrollTop, overlap: gap, rows: rows.length })
    }
    const reads = window.__conversationProcess.contentStats()
    return { overlap, mounted, samples, reads, acceptedReads }
  })
  expect(result.overlap).toBeLessThanOrEqual(1)
  expect(result.samples.every((sample) => sample.rows > 0)).toBe(true)
  expect(result.mounted).toBeLessThan(40)
  expect(Object.keys(result.acceptedReads).length).toBeGreaterThan(10)
  for (const [id, count] of Object.entries(result.acceptedReads)) expect(result.reads[id], id).toBe(count)
  expect(Object.keys(result.reads).length).toBeLessThan(120)
}, 30000)

test("opening cold long prose bounds body demand instead of reading the entire hidden process", async () => {
  await page.goto(`${url}?content=long-prose&collapsed&body-delay=80`)
  const trigger = page.locator('[data-slot="turn-process-trigger"]')
  await trigger.waitFor()
  expect(Object.keys(await page.evaluate(() => window.__conversationProcess.contentStats()))).toEqual(["request"])
  await trigger.click()
  await page.waitForFunction(() => !!document.querySelector('[data-part-id="long-0"] [data-component="markdown"]'))
  await page.waitForFunction(() => !document.querySelector("[data-motion-changing]"))
  const reads = await page.evaluate(() => window.__conversationProcess.contentStats())
  expect(Object.keys(reads).length).toBeLessThan(40)
  expect(Math.max(...Object.values(reads))).toBe(1)
}, 30000)

test.each(["index.mjs", "index.jsx"] as const)(
  "cold history body admission moves neighbouring rows in the same painted frame (%s)",
  async (entry) => {
    const alternate = entry === "index.jsx" ? await fixtureServer(entry) : undefined
    const target = alternate ? await browser.newPage() : page
    await observeResizeErrors(target)
    try {
      await target.goto(`${alternate?.url ?? url}?content=long-prose&collapsed&body-delay=80`)
      await target.locator('[data-scroller][data-hydrated="true"]').waitFor()
      await target.locator('[data-slot="turn-process-trigger"]').waitFor()
      const trace = await target.evaluate(async () => {
        document.querySelector<HTMLButtonElement>('[data-slot="turn-process-trigger"]')!.click()
        const trace = []
        for (let frame = 0; frame < 90; frame++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
          const view = document.querySelector("[data-scroller]")!.getBoundingClientRect()
          const rows = [...document.querySelectorAll<HTMLElement>("[data-display-row]")].filter(
            (row) =>
              row.checkVisibility({ visibilityProperty: true, opacityProperty: true }) &&
              row.getBoundingClientRect().bottom > view.top &&
              row.getBoundingClientRect().top < view.bottom,
          )
          trace.push(
            rows.map((row) => ({
              key: row.dataset.displayRow,
              top: row.getBoundingClientRect().top,
              bottom: row.getBoundingClientRect().bottom,
              pending: row.hasAttribute("data-content-pending"),
              transform: getComputedStyle(row).transform,
            })),
          )
        }
        return trace
      })
      expect(trace.every((rows) => rows.length > 0)).toBe(true)
      expect(
        Math.max(...trace.flatMap((rows) => rows.slice(1).map((row, i) => rows[i].bottom - row.top))),
      ).toBeLessThanOrEqual(2)
      expect(await target.evaluate(() => window.__resizeErrors)).toEqual([])
    } finally {
      if (alternate) {
        await target.close()
        await alternate.close()
      }
    }
  },
  30000,
)

test("scrolling into cold history accepts text without overlapping neighbouring rows", async () => {
  await page.goto(`${url}?content=long-prose&body-delay=80`)
  await page.waitForFunction(() => !!document.querySelector('[data-part-id="long-0"] [data-component="markdown"]'))
  const result = await page.evaluate(async () => {
    const control = window.__conversationProcess
    const viewport = document.querySelector<HTMLElement>("[data-scroller]")!
    control.reading(true)
    control.contentPending("long-35")
    let row: HTMLElement | null = null
    for (let step = 0; step < 240; step++) {
      row = document.querySelector<HTMLElement>('[data-part-id="long-35"]')
      if (row) break
      viewport.scrollTop += 240
      await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
    }
    if (!row) throw new Error("Cold history row was never admitted")
    row.focus({ preventScroll: true })
    viewport.scrollTop += row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 180
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    const pending = row.hasAttribute("data-content-pending")
    control.contentFinish("long-35")
    const samples = []
    for (let step = 0; step < 45; step++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
      const bounds = viewport.getBoundingClientRect()
      const rows = [...viewport.querySelectorAll<HTMLElement>("[data-display-row]")].filter(
        (row) =>
          row.checkVisibility({ visibilityProperty: true, opacityProperty: true }) &&
          row.getBoundingClientRect().bottom > bounds.top &&
          row.getBoundingClientRect().top < bounds.bottom,
      )
      samples.push(
        Math.max(
          0,
          ...rows
            .slice(1)
            .map((next, index) => rows[index].getBoundingClientRect().bottom - next.getBoundingClientRect().top),
        ),
      )
    }
    return { pending, samples, text: row.textContent, reads: control.contentReads("long-35") }
  })
  expect(result.pending).toBe(true)
  expect(result.text).toContain("中间过程 35")
  expect(result.reads).toBe(1)
  expect(Math.max(...result.samples)).toBeLessThanOrEqual(1)
  expect(await page.evaluate(() => window.__resizeErrors)).toEqual([])
}, 30000)

test("manual historical disclosure stays measurable while another body delays motion admission", async () => {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 })
  await page.goto(`${url}?content=long-prose&mixed-history&collapsed&body-delay=80&motion&hold-answer`)
  await page.locator('[data-slot="turn-process-trigger"]').waitFor()
  expect(await page.locator("[data-scroller]").getAttribute("data-hydrated")).toBe("false")
  const samples = await page.locator('[data-slot="turn-process-trigger"]').evaluate(async (button) => {
    const view = document.querySelector<HTMLElement>("[data-scroller]")!
    const samples: number[] = []
    const sample = () => {
      const bounds = view.getBoundingClientRect()
      const rows = [...view.querySelectorAll<HTMLElement>("[data-display-row]")].filter(
        (row) =>
          !row.closest('[data-component="process-viewport"]') &&
          row.checkVisibility({ visibilityProperty: true, opacityProperty: true }) &&
          row.getBoundingClientRect().bottom > bounds.top &&
          row.getBoundingClientRect().top < bounds.bottom,
      )
      samples.push(
        Math.max(
          0,
          ...rows.slice(1).map((row, i) => rows[i].getBoundingClientRect().bottom - row.getBoundingClientRect().top),
        ),
      )
    }
    const resize = new ResizeObserver(sample)
    const observed = new Set<Element>()
    const observe = () => {
      for (const row of view.querySelectorAll("[data-display-row]")) {
        if (observed.has(row)) continue
        observed.add(row)
        resize.observe(row)
      }
    }
    const mutations = new MutationObserver(observe)
    mutations.observe(view, { childList: true, subtree: true })
    observe()
    ;(button as HTMLButtonElement).click()
    for (let frame = 0; frame < 75; frame++) await new Promise(requestAnimationFrame)
    mutations.disconnect()
    resize.disconnect()
    return samples
  })
  expect(samples.length).toBeGreaterThan(0)
  expect(Math.max(...samples)).toBeLessThanOrEqual(2)
  expect(await page.evaluate(() => window.__resizeErrors)).toEqual([])
}, 30000)

test.each([0, 16, 80])(
  "prepending history while a long reply arrives preserves the current reading anchor (%d ms)",
  async (delay) => {
    await page.goto(
      `${url}?content=previous-answer&scrolling&history-controls&keep-history-control&body-delay=${delay}`,
    )
    await page.getByText("Current result remains visible.", { exact: false }).waitFor()
    await page.waitForFunction(() => !document.querySelector("[data-motion-changing]"))
    const viewport = page.locator("[data-scroller]")
    await viewport.evaluate((v) => {
      v.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }))
      v.scrollTop = 0
    })
    await frames()
    await page.evaluate(() => window.__conversationProcess.contentPending("previous-answer-body"))
    const recording = viewport.evaluate(async (v) => {
      const anchor = v.querySelector<HTMLElement>('[data-display-row="previous-root:user"]')!
      const initial = anchor.getBoundingClientRect().top
      await new Promise<void>((resolve) =>
        v.querySelector("button")!.addEventListener("click", () => resolve(), { once: true }),
      )
      const samples = []
      let released = false
      for (let frame = 0; frame < 90; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
        if (!released && frame >= 2 && window.__conversationProcess.contentReads("previous-answer-body")) {
          window.__conversationProcess.contentFinish("previous-answer-body")
          released = true
        }
        const bounds = v.getBoundingClientRect()
        const rows = [...v.querySelectorAll<HTMLElement>("[data-display-row]")].filter(
          (row) =>
            !row.closest('[data-component="process-viewport"]') &&
            row.checkVisibility({ visibilityProperty: true, opacityProperty: true }) &&
            row.getBoundingClientRect().bottom > bounds.top &&
            row.getBoundingClientRect().top < bounds.bottom,
        )
        samples.push({
          drift: anchor.getBoundingClientRect().top - initial,
          connected: anchor.isConnected,
          rows: rows.length,
        })
      }
      return { samples, released }
    })
    await page.getByRole("button", { name: "Load earlier messages", exact: true }).click()
    const { samples, released } = await recording
    expect(released).toBe(true)
    expect(samples.every((sample) => sample.connected && sample.rows > 0)).toBe(true)
    expect(Math.max(...samples.map((sample) => Math.abs(sample.drift)))).toBeLessThanOrEqual(2)
    await page.getByText("Evidence 0", { exact: true }).waitFor()
    await frames()
    const overlap = await viewport.evaluate((v) => {
      const bounds = v.getBoundingClientRect()
      const rows = [...v.querySelectorAll<HTMLElement>("[data-display-row]")].filter(
        (row) =>
          row.checkVisibility({ visibilityProperty: true, opacityProperty: true }) &&
          row.getBoundingClientRect().bottom > bounds.top &&
          row.getBoundingClientRect().top < bounds.bottom,
      )
      return Math.max(
        0,
        ...rows.slice(1).map((row, i) => rows[i].getBoundingClientRect().bottom - row.getBoundingClientRect().top),
      )
    })
    expect(overlap).toBeLessThanOrEqual(1)
    expect(await page.evaluate(() => window.__conversationProcess.contentReads("previous-answer-body"))).toBe(1)
    expect(await page.evaluate(() => window.__resizeErrors)).toEqual([])
  },
  30000,
)

test.each([
  { keep: false, frame: false },
  { keep: true, frame: false },
  { keep: false, frame: true },
  { keep: true, frame: true },
])(
  "cold long replies prepended above the reader publish their heights with their bodies (%j)",
  async ({ keep, frame }) => {
    await page.goto(
      `${url}?content=long-history&scrolling&history-controls&body-delay=80${frame ? "&body-frame" : ""}${keep ? "&keep-history-control" : ""}`,
    )
    await page.getByText("Current history anchor.", { exact: false }).waitFor()
    const viewport = page.locator("[data-scroller]")
    await viewport.evaluate((v) => {
      v.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }))
      v.scrollTop = 0
    })
    await frames()
    const recording = viewport.evaluate(async (v) => {
      const anchor = v.querySelector<HTMLElement>('[data-display-row="root:user"]')!
      const top = anchor.getBoundingClientRect().top
      await new Promise<void>((resolve) =>
        v.querySelector("button")!.addEventListener("click", () => resolve(), { once: true }),
      )
      const samples = []
      for (let i = 0; i < 90; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
        const bounds = v.getBoundingClientRect()
        const rows = [...v.querySelectorAll<HTMLElement>("[data-display-row]")].filter(
          (row) =>
            row.checkVisibility({ visibilityProperty: true, opacityProperty: true }) &&
            row.getBoundingClientRect().bottom > bounds.top &&
            row.getBoundingClientRect().top < bounds.bottom,
        )
        samples.push({
          drift: anchor.getBoundingClientRect().top - top,
          rows: rows.length,
          overlap: Math.max(
            0,
            ...rows.slice(1).map((row, i) => rows[i].getBoundingClientRect().bottom - row.getBoundingClientRect().top),
          ),
        })
      }
      return samples
    })
    await page.getByRole("button", { name: "Load earlier messages", exact: true }).click()
    const samples = await recording
    expect(samples.every((s) => s.rows > 0)).toBe(true)
    expect(Math.max(...samples.map((s) => Math.abs(s.drift)))).toBeLessThanOrEqual(2)
    expect(Math.max(...samples.map((s) => s.overlap))).toBeLessThanOrEqual(1)
    expect(await page.evaluate(() => window.__resizeErrors)).toEqual([])
  },
  30000,
)
