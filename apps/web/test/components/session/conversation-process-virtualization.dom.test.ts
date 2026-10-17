import { expect, test } from "bun:test"
import type {} from "../../fixtures/conversation/keyed-layout"
import {
  browser,
  page,
  url,
  errors,
  observeResizeErrors,
  fixtureServer,
  frames,
} from "../../support/conversation-process"

test.each(["index.mjs", "index.jsx"] as const)(
  "keyed middle edits preserve retained measurements before the next resize (%s)",
  async (entry) => {
    const alternate = entry === "index.jsx" ? await fixtureServer(entry) : undefined
    const target = alternate ? await browser.newPage() : page
    try {
      await target.goto(`${alternate?.url ?? url}keyed.html`)
      await target.waitForFunction(
        () => window.keyedLayout?.measure().find((row) => row.id === "answer")?.size === 2034.75,
      )
      const result = await target.evaluate(async () => {
        const fixture = window.keyedLayout
        const viewport = fixture.viewport()
        viewport.scrollTop = 2380
        await new Promise(requestAnimationFrame)
        const answer = document.querySelector('[data-row="answer"]')!
        const header = document.querySelector('[data-row="header"]')!
        const top = header.getBoundingClientRect().top
        const samples: {
          phase: string
          measured: number
          offsetGap: number
          actual: number
          drift: number
          same: boolean
        }[] = []
        for (const phase of ["collapse", "expand", "reorder"] as const) {
          fixture[phase]()
          for (let frame = 0; frame < 8; frame++) {
            const rows = fixture.measure()
            const index = rows.findIndex((row) => row.id === "answer")
            samples.push({
              phase,
              measured: rows[index].size,
              offsetGap: rows[index + 1].offset - rows[index].offset,
              actual: answer.getBoundingClientRect().height,
              drift: header.getBoundingClientRect().top - top,
              same: answer === document.querySelector('[data-row="answer"]'),
            })
            await new Promise(requestAnimationFrame)
          }
        }
        fixture.prepend()
        for (let frame = 0; frame < 8; frame++) await new Promise(requestAnimationFrame)
        return { samples, prependedDrift: header.getBoundingClientRect().top - top }
      })
      for (const sample of result.samples) {
        expect(sample.measured, sample.phase).toBeCloseTo(sample.actual, 1)
        expect(sample.offsetGap, sample.phase).toBeCloseTo(sample.actual, 1)
        expect(Math.abs(sample.drift), sample.phase).toBeLessThanOrEqual(1)
        expect(sample.same, sample.phase).toBe(true)
      }
      expect(Math.abs(result.prependedDrift)).toBeLessThanOrEqual(1)
    } finally {
      if (alternate) {
        await target.close()
        await alternate.close()
      }
    }
  },
  30000,
)

test.each(["index.mjs", "index.jsx"] as const)(
  "following a newly appended short row never rebounds after accepting its size (%s)",
  async (entry) => {
    const alternate = entry === "index.jsx" ? await fixtureServer(entry) : undefined
    const target = alternate ? await browser.newPage() : page
    try {
      await target.goto(`${alternate?.url ?? url}keyed.html?following`)
      await target.waitForFunction(() => {
        const view = window.keyedLayout?.viewport()
        return view && view.scrollTop > 1000 && view.scrollHeight - view.clientHeight - view.scrollTop < 1
      })
      await target.waitForFunction(() => !document.getAnimations().length)
      const result = await target.evaluate(async () => {
        const anchor = document.querySelector('[data-row="history-11"]')!
        const y = () => anchor.getBoundingClientRect().top
        const before = y()
        window.keyedLayout.append()
        const samples = []
        const deadline = performance.now() + 3000
        let settled = false
        while (performance.now() < deadline) {
          await new Promise(requestAnimationFrame)
          await new Promise((resolve) => setTimeout(resolve, 0))
          samples.push(y())
          if (
            samples.length > 2 &&
            !document.querySelector("[data-motion-resizing]") &&
            !document.getAnimations().length
          ) {
            settled = true
            break
          }
        }
        return { before, samples, settled }
      })
      expect(result.settled).toBe(true)
      expect(result.samples.at(-1)).toBeCloseTo(result.before - 33, 0)
      for (let index = 0; index < result.samples.length; index++) {
        expect(result.samples[index], JSON.stringify(result)).toBeGreaterThanOrEqual(result.before - 34)
        expect(
          result.samples[index] - (result.samples[index - 1] ?? result.before),
          JSON.stringify(result),
        ).toBeLessThanOrEqual(1)
      }
    } finally {
      if (alternate) {
        await target.close()
        await alternate.close()
      }
    }
  },
  30000,
)

test("first overflowing row follows its measured height without a rebound", async () => {
  await page.goto(`${url}keyed.html?following&underflow`)
  await page.waitForFunction(() => window.keyedLayout?.measure()[0]?.size === 580)
  const result = await page.evaluate(async () => {
    const anchor = document.querySelector('[data-row="history-11"]')!
    const before = anchor.getBoundingClientRect().top
    window.keyedLayout.append()
    const samples = []
    for (let frame = 0; frame < 30; frame++) {
      await new Promise(requestAnimationFrame)
      await new Promise((resolve) => setTimeout(resolve, 0))
      samples.push(anchor.getBoundingClientRect().top)
    }
    return { before, samples }
  })
  expect(result.samples.at(-1)).toBeCloseTo(result.before - 13, 0)
  expect(
    Math.max(...result.samples.map((y, index) => y - (result.samples[index - 1] ?? result.before))),
    JSON.stringify(result),
  ).toBeLessThanOrEqual(1)
})

test("a tool entrance preserves an in-flight following offset instead of snapping the transcript", async () => {
  await page.goto(`${url}keyed.html?following`)
  await page.waitForFunction(() => window.keyedLayout?.viewport().scrollTop > 1000)
  await page.waitForFunction(() => !document.getAnimations().length)
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('[data-row="history-11"] > div')!.style.height = "412px"
  })
  await page.waitForFunction(() => !!document.querySelector("[data-follow-motion]")?.getAnimations().length)
  const result = await page.evaluate(async () => {
    const animation = document.querySelector("[data-follow-motion]")!.getAnimations()[0]
    animation.pause()
    animation.currentTime = 40
    const anchor = document.querySelector('[data-row="history-11"]')!
    const before = anchor.getBoundingClientRect().top
    const animate = Element.prototype.animate
    Element.prototype.animate = function (...args) {
      const next = animate.apply(this, args)
      if (this.hasAttribute("data-follow-motion")) {
        next.pause()
        next.currentTime = 0
      }
      return next
    }
    window.keyedLayout.append()
    const samples = []
    try {
      for (let frame = 0; frame < 8; frame++) {
        await new Promise(requestAnimationFrame)
        samples.push(anchor.getBoundingClientRect().top)
      }
    } finally {
      Element.prototype.animate = animate
    }
    return { before, samples }
  })
  expect(Math.max(...result.samples.map((y) => Math.abs(result.before - y))), JSON.stringify(result)).toBeLessThan(1)
}, 30000)

test("terminal process collection preserves the visible answer while following its painted position", async () => {
  await page.goto(`${url}?scrolling&motion`)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => {
    window.__conversationProcess.grow(20)
    window.__conversationProcess.stream(
      "Final answer remains readable while the completed process collects. ".repeat(30),
    )
    window.__conversationProcess.latest()
  })
  await frames()
  await page.waitForFunction(
    () =>
      !document.querySelector("[data-markdown-pending]") &&
      !document.querySelector("[data-motion-resizing]") &&
      !document.querySelector("[data-follow-motion]")!.getAnimations().length,
  )
  const result = await page.evaluate(async () => {
    const viewport = document.querySelector<HTMLElement>("[data-scroller]")!
    const current = () => document.querySelector('[data-part-id="answer"]')?.closest("[data-display-row]")
    const answer = current()!
    const initial = answer.getBoundingClientRect().top
    const height = viewport.scrollHeight
    window.__conversationProcess.complete()
    const samples = []
    for (let frame = 0; frame < 60; frame++) {
      await new Promise(requestAnimationFrame)
      await new Promise((resolve) => setTimeout(resolve, 0))
      samples.push({
        y: answer.getBoundingClientRect().top,
        height: viewport.scrollHeight,
        same: answer === current(),
        connected: answer.isConnected,
      })
    }
    return { initial, height, samples }
  })
  expect(result.height - result.samples.at(-1)!.height).toBeGreaterThan(100)
  for (let index = 0; index < result.samples.length; index++) {
    const sample = result.samples[index]
    expect(sample.same, JSON.stringify(result)).toBe(true)
    expect(sample.y - (result.samples[index - 1]?.y ?? result.initial), JSON.stringify(result)).toBeLessThanOrEqual(1)
    expect(sample.y, JSON.stringify(result)).toBeGreaterThanOrEqual(result.samples.at(-1)!.y - 1)
  }
}, 30000)

test.each([false, true])(
  "a first overflowing activity does not rebound after initial admission (pending page: %j)",
  async (pending) => {
    await page.goto(`${url}?scrolling&motion&content=tool-follow&underflow&empty${pending ? "&initial-page" : ""}`)
    await page.waitForFunction(() => !!window.__conversationProcess)
    await frames()
    await page.evaluate(() => window.__conversationProcess.prepare())
    await frames()
    if (pending) {
      await page.locator('[data-display-row="root:load"]').waitFor()
      await page.evaluate(() => window.__conversationProcess.hydrateBefore(0))
      await frames()
      await page.evaluate(() => window.__conversationProcess.continuationReady())
      await page.locator('[data-display-row="root:load"]').waitFor({ state: "detached" })
    }
    await page.evaluate(() =>
      window.__conversationProcess.phase({ phase: "waiting_model", startedAt: 1, rootID: "root" }),
    )
    await page.evaluate(() => window.__conversationProcess.nextTool("next"))
    await frames()
    await page.waitForFunction(
      () =>
        !document.querySelector("[data-motion-resizing]") &&
        !document.querySelector("[data-follow-motion]")!.getAnimations().length,
    )
    await page.evaluate(() => {
      const view = document.querySelector<HTMLElement>("[data-scroller]")!
      const content = document.querySelector<HTMLElement>("[data-follow-motion]")!
      const outside = document.querySelector<HTMLElement>("[data-outside-control]")!
      view.style.height = `${content.offsetHeight + outside.offsetHeight + 20}px`
    })
    await frames()
    const result = await page.evaluate(async () => {
      const view = document.querySelector<HTMLElement>("[data-scroller]")!
      const anchor = document.querySelector('[data-display-row][data-part-id="next-progress"]')!
      const samples = [anchor.getBoundingClientRect().top]
      const before = view.scrollTop
      window.__conversationProcess.nextTool("next", "pending")
      for (let frame = 0; frame < 40; frame++) {
        await new Promise(requestAnimationFrame)
        await new Promise((resolve) => setTimeout(resolve, 0))
        samples.push(anchor.getBoundingClientRect().top)
      }
      return { before, after: view.scrollTop, samples }
    })
    expect(result.before).toBe(0)
    expect(result.after).toBeGreaterThan(0)
    expect(
      Math.max(...result.samples.slice(1).map((y, index) => y - result.samples[index])),
      JSON.stringify(result),
    ).toBeLessThanOrEqual(1)
  },
)

test.each(["pending", "generating"] as const)(
  "a %s tool does not add and remove a phantom body before its input is displayable",
  async (status) => {
    await page.goto(`${url}?scrolling&motion&content=tool-follow`)
    await page.getByText("I will check the project first.", { exact: true }).waitFor()
    await page.evaluate(() => {
      window.__conversationProcess.grow(20)
      window.__conversationProcess.nextTool("next")
      window.__conversationProcess.latest()
    })
    await frames()
    await page.waitForFunction(
      () =>
        !document.querySelector("[data-motion-resizing]") &&
        !document.querySelector("[data-follow-motion]")!.getAnimations().length,
    )
    const arrival = await page.evaluate(async (status) => {
      const anchor = document.querySelector('[data-display-row][data-part-id="next-progress"]')!
      const samples = [anchor.getBoundingClientRect().top]
      window.__conversationProcess.nextTool("next", status)
      for (let frame = 0; frame < 40; frame++) {
        await new Promise(requestAnimationFrame)
        await new Promise((resolve) => setTimeout(resolve, 0))
        samples.push(anchor.getBoundingClientRect().top)
      }
      return samples
    }, status)
    expect(
      Math.max(...arrival.slice(1).map((y, index) => y - arrival[index])),
      JSON.stringify(arrival),
    ).toBeLessThanOrEqual(1)
    await page.locator('[data-part-id="next-tool"][data-content-pending]').waitFor()
    await page.waitForFunction(
      () =>
        !document.querySelector("[data-motion-resizing]") &&
        !document.querySelector("[data-follow-motion]")!.getAnimations().length,
    )
    const result = await page.evaluate(async () => {
      const viewport = document.querySelector<HTMLElement>("[data-scroller]")!
      const anchor = document.querySelector('[data-display-row][data-part-id="next-progress"]')!
      const before = anchor.getBoundingClientRect().top
      const height = viewport.scrollHeight
      const animate = Element.prototype.animate
      Element.prototype.animate = function (...args) {
        const next = animate.apply(this, args)
        if (this.hasAttribute("data-follow-motion")) {
          next.pause()
          next.currentTime = 0
        }
        return next
      }
      const samples = []
      try {
        window.__conversationProcess.contentFinish("next-tool")
        for (let frame = 0; frame < 30; frame++) {
          await new Promise(requestAnimationFrame)
          await new Promise((resolve) => setTimeout(resolve, 0))
          samples.push({ y: anchor.getBoundingClientRect().top, connected: anchor.isConnected })
        }
        return { before, height, finalHeight: viewport.scrollHeight, samples }
      } finally {
        Element.prototype.animate = animate
      }
    })
    expect(Math.abs(result.height - result.finalHeight), JSON.stringify(result)).toBeLessThanOrEqual(1)
    expect(await page.locator('[data-part-id="next-tool"][data-content-pending]').count()).toBe(0)
    expect(result.samples.every((sample) => sample.connected)).toBe(true)
    expect(
      Math.max(...result.samples.map((sample) => Math.abs(sample.y - result.before))),
      JSON.stringify(result),
    ).toBeLessThanOrEqual(1)
  },
  30000,
)

test("an empty live continuation loads without inserting and removing a transcript gap", async () => {
  await page.goto(`${url}?scrolling&motion`)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => {
    window.__conversationProcess.grow(20)
    window.__conversationProcess.nextTool("next")
    window.__conversationProcess.latest()
  })
  await frames()
  await page.waitForFunction(
    () => !document.querySelector("[data-motion-resizing]") && !document.getAnimations().length,
  )
  const result = await page.evaluate(async () => {
    const view = document.querySelector<HTMLElement>("[data-scroller]")!
    const anchor = document.querySelector('[data-display-row][data-part-id="next-progress"]')!
    const before = anchor.getBoundingClientRect().top
    const reads = window.__conversationProcess.contentPageLoads()
    window.__conversationProcess.continuation()
    const samples = []
    for (let frame = 0; frame < 70; frame++) {
      if (frame === 35) window.__conversationProcess.continuationReady()
      await new Promise(requestAnimationFrame)
      await new Promise((resolve) => setTimeout(resolve, 0))
      const pending = view.querySelector('[data-display-row="continuation:load"]')
      samples.push({
        y: anchor.getBoundingClientRect().top,
        pending: pending?.getBoundingClientRect().height,
        connected: anchor.isConnected,
      })
    }
    return { before, samples, requests: window.__conversationProcess.contentPageLoads() - reads }
  })
  expect(result.requests).toBe(1)
  expect(result.samples.every((sample) => sample.connected)).toBe(true)
  expect(result.samples.some((sample) => sample.pending !== undefined)).toBe(true)
  expect(Math.max(...result.samples.map((sample) => sample.pending ?? 0))).toBe(0)
  expect(
    Math.max(...result.samples.map((sample) => Math.abs(sample.y - result.before))),
    JSON.stringify(result),
  ).toBeLessThanOrEqual(1)
}, 30000)

test.each([
  ["first-response", "following"],
  ["first-response", "reading"],
  ["continuation", "following"],
  ["continuation", "reading"],
] as const)(
  "hidden runtime context cannot move the transcript during %s (%s)",
  async (stage, mode) => {
    await page.goto(`${url}?scrolling&motion${stage === "first-response" ? "&first-response" : ""}`)
    await page
      .getByText(stage === "first-response" ? "Describe the project" : "I will check the project first.", {
        exact: true,
      })
      .waitFor()
    await page.evaluate((stage) => {
      if (stage === "continuation") {
        window.__conversationProcess.grow(20)
        window.__conversationProcess.nextTool("next")
      }
      window.__conversationProcess.latest()
    }, stage)
    await page.waitForFunction(() => {
      const view = document.querySelector<HTMLElement>("[data-scroller]")!
      return (
        view.scrollHeight - view.clientHeight - view.scrollTop < 1 &&
        !document.querySelector("[data-motion-resizing]") &&
        !document.getAnimations().some((animation) => animation.effect?.getTiming().iterations !== Infinity)
      )
    })
    if (mode === "reading") {
      await page.evaluate(() => {
        const view = document.querySelector<HTMLElement>("[data-scroller]")!
        window.__conversationProcess.reading(true)
        view.dispatchEvent(new WheelEvent("wheel", { deltaY: -180, bubbles: true }))
        view.scrollTop -= 180
      })
      await frames()
    }
    const result = await page.evaluate(async () => {
      const fixture = window.__conversationProcess
      const view = document.querySelector<HTMLElement>("[data-scroller]")!
      const viewport = view.getBoundingClientRect()
      const anchor = [...view.querySelectorAll<HTMLElement>('[data-display-row][data-row-kind="body"]')].find(
        (row) => row.getBoundingClientRect().bottom > viewport.top && row.getBoundingClientRect().top < viewport.bottom,
      )!
      const before = anchor.getBoundingClientRect().top
      fixture.phase({ phase: "preparing_context", startedAt: 2, rootID: "root" })
      fixture.runtimeContext()
      const samples = []
      for (let frame = 0; frame < 80; frame++) {
        if (frame === 8) fixture.continuation()
        if (frame === 35) fixture.runtimeContextReady()
        if (frame === 45) {
          fixture.continuationReady()
          fixture.phase({ phase: "waiting_model", startedAt: 3, rootID: "root" })
        }
        await new Promise(requestAnimationFrame)
        await new Promise((resolve) => setTimeout(resolve, 0))
        samples.push({
          drift: anchor.getBoundingClientRect().top - before,
          connected: anchor.isConnected,
          hiddenRow: !!view.querySelector('[data-display-row="runtime-context:load"]'),
        })
      }
      return {
        samples,
        hiddenReads: fixture.contentPageLoads("runtime-context"),
        responseReads: fixture.contentPageLoads("continuation"),
      }
    })
    expect(
      Math.max(...result.samples.map((sample) => Math.abs(sample.drift))),
      JSON.stringify(result),
    ).toBeLessThanOrEqual(1)
    expect(
      result.samples.every((sample) => sample.connected && !sample.hiddenRow),
      JSON.stringify(result),
    ).toBe(true)
    expect(result.hiddenReads).toBe(0)
    expect(result.responseReads).toBe(1)
    expect(errors).toEqual([])
  },
  30000,
)

test("focus outside a large conversation does not reread its summaries", async () => {
  await page.goto(`${url}?scrolling`)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => window.__conversationProcess.grow(1000))
  await frames()
  const before = await page.evaluate(() => window.__conversationProcess.summaryReads())
  const outside = page.getByRole("button", { name: "Outside conversation", exact: true })
  for (let index = 0; index < 3; index++) {
    await outside.focus()
    await outside.evaluate((element) => (element as HTMLElement).blur())
  }
  await frames()
  expect(await page.evaluate(() => window.__conversationProcess.summaryReads())).toBe(before)
}, 30000)

test("reading a finished full process does not retrace unchanged disclosure state", async () => {
  await page.goto(`${url}?scrolling`)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => {
    window.__conversationProcess.mode("full")
    window.__conversationProcess.stream()
    window.__conversationProcess.grow(1000)
    window.__conversationProcess.complete()
  })
  await frames()
  const before = await page.evaluate(() => window.__conversationProcess.summaryReads())
  await page.evaluate(() => window.__conversationProcess.reading(true))
  await frames()
  await page.evaluate(() => window.__conversationProcess.reading(false))
  await frames()
  expect(await page.evaluate(() => window.__conversationProcess.summaryReads())).toBe(before)
}, 30000)

test.each(["index.mjs", "index.jsx"] as const)(
  "visible fixed viewports and native hit testing survive resize and scrolling (%s)",
  async (entry) => {
    const alternate = entry === "index.jsx" ? await fixtureServer(entry) : undefined
    const target = alternate ? await browser.newPage() : page
    target.setDefaultTimeout(15000)
    if (alternate) target.on("pageerror", (error) => errors.push(error.message))
    try {
      await target.goto(`${alternate?.url ?? url}resize.html?fixed`)
      await target.getByRole("button", { name: "Item 0", exact: true }).waitFor()
      await frames(target)
      expect(await target.evaluate(() => window.__conversationResizeList!.viewportSize)).toBe(288)
      await target.evaluate(() => window.__conversationResizeList!.scrollToIndex(80, { align: "start" }))
      await target.getByRole("button", { name: "Item 80", exact: true }).waitFor()
      const hit = await target.getByLabel("Measured list").evaluate(async (element) => {
        element.scrollTop += 48
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        const rect = element.getBoundingClientRect()
        return element.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + 24))
      })
      expect(hit).toBe(true)
      expect(errors).toEqual([])
    } finally {
      if (alternate) {
        await target.close()
        await alternate.close()
      }
    }
  },
  30000,
)

test.each(["index.mjs", "index.jsx"] as const)(
  "history hydration, hidden lists and process disclosure retain measured geometry (%s)",
  async (entry) => {
    const alternate = entry === "index.jsx" ? await fixtureServer(entry) : undefined
    const target = alternate ? await browser.newPage() : page
    target.setDefaultTimeout(15000)
    if (alternate) target.on("pageerror", (error) => errors.push(error.message))
    await observeResizeErrors(target)
    try {
      const base = alternate?.url ?? url
      await target.goto(`${base}resize.html`)
      const list = target.getByLabel("Measured list")
      await list.evaluate((element) => {
        element.scrollTop = 1440
      })
      const item = target.getByRole("button", { name: "Item 30", exact: true })
      await item.waitFor()
      const before = await item.boundingBox()
      await target.getByRole("button", { name: "Toggle list", exact: true }).evaluate(async (element) => {
        ;(element as HTMLButtonElement).click()
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        ;(element as HTMLButtonElement).click()
        for (let frame = 0; frame < 4; frame++)
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      })
      expect(await list.evaluate((element) => element.scrollTop)).toBe(1440)
      const after = await item.boundingBox()
      expect(after).not.toBeNull()
      expect(Math.abs(after!.y - before!.y)).toBeLessThan(1)
      expect(await list.getByRole("button").count()).toBeLessThan(20)
      expect(await target.evaluate(() => window.__resizeErrors)).toEqual([])
      await list.evaluate(async (element) => {
        const list = element as HTMLElement
        list.style.width = "0px"
        list.style.height = "0px"
        for (let frame = 0; frame < 4; frame++)
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      })
      expect(await target.evaluate(() => window.__conversationResizeList?.viewportSize)).toBe(0)
      await target.goto(alternate?.url ?? url)
      await target.getByText("I will check the project first.", { exact: true }).waitFor()
      await target.evaluate(() => {
        window.__conversationProcess.grow(80)
        window.__conversationProcess.stream()
        window.__conversationProcess.complete()
      })
      const trigger = target.locator('[data-slot="turn-process-trigger"]')
      await target.waitForFunction(() => !document.querySelector('[data-row-kind="activity"]'))
      await trigger.press("Enter")
      const batch = target.locator('[data-component="conversation-activity"] > button').last()
      await batch.waitFor()
      await batch.focus()
      expect(await batch.evaluate((element) => element === document.activeElement)).toBe(true)
      if ((await batch.getAttribute("aria-expanded")) !== "true") await batch.press("Enter")
      const viewport = target.locator('[data-component="process-viewport"]').last()
      await viewport.waitFor()
      await target.waitForFunction(() => !document.querySelector("[data-motion-changing]"))
      const heights = await target
        .locator('[data-slot="activity-batch-content"]')
        .last()
        .evaluate(async (element) => {
          const heights: number[] = []
          for (let frame = 0; frame < 8; frame++) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
            heights.push(element.getBoundingClientRect().height)
          }
          return heights
        })
      expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1)
      await target.waitForFunction(() => !document.querySelector("[data-motion-changing]"))
      for (const height of [420, 700, 600]) {
        await target.locator("[data-scroller]").evaluate((element, height) => {
          ;(element as HTMLElement).style.height = `${height}px`
        }, height)
        await target.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
        )
        expect(await viewport.evaluate((element) => element.clientHeight)).toBeLessThanOrEqual(height * 0.45)
      }
      await batch.press("Enter")
      await target.waitForFunction(() => !document.querySelector('[data-slot="activity-step-trigger"]'))
      await batch.press("Enter")
      await viewport.waitFor()
      await target.waitForFunction(() => !document.querySelector("[data-motion-changing]"))
      await target.evaluate(() => window.__conversationProcess.hydrateBefore(24))
      await target.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      )
      await target.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      )
      await target.locator("[data-scroller]").evaluate(async (element) => {
        ;(element as HTMLElement).style.height = "420px"
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        window.__conversationProcess.prepare()
      })
      await target.waitForFunction(() => !document.querySelector('[data-component="process-viewport"]'))
      expect(await target.evaluate(() => window.__resizeErrors)).toEqual([])
    } finally {
      if (alternate) {
        await target.close()
        await alternate.close()
      }
    }
  },
  60000,
)

test("repeated process reading input does not rebuild unchanged conversation summaries", async () => {
  await page.goto(`${url}?scrolling`)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => window.__conversationProcess.grow(600))
  const batch = page.locator('[data-slot="activity-batch-trigger"]').last()
  await batch.click()
  await batch.click()
  const viewport = page.locator('[data-component="process-viewport"]').last()
  await viewport.waitFor()
  await viewport.dispatchEvent("wheel", { deltaY: -1 })
  await frames()
  await frames()
  const before = await page.evaluate(() => window.__conversationProcess.summaryReads())
  for (let index = 0; index < 6; index++) {
    await viewport.dispatchEvent("wheel", { deltaY: -1 })
    await frames()
  }
  expect(await page.evaluate(() => window.__conversationProcess.summaryReads())).toBe(before)
  expect(errors).toEqual([])
})

test("a long logical block uses a bounded independent viewport", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => window.__conversationProcess.grow(1000))
  const viewport = page.locator('[data-component="process-viewport"]').last()
  await viewport.waitFor()
  const geometry = await viewport.evaluate((el) => ({
    height: el.clientHeight,
    overflow: el.scrollHeight > el.clientHeight,
  }))
  expect(geometry.height).toBeLessThanOrEqual(270)
  expect(geometry.overflow).toBe(true)
  expect(await viewport.locator("..").getAttribute("data-overflow")).toBe("")
  await viewport.hover()
  await frames()
  const mainOffset = await page.locator("[data-scroller]").evaluate((el) => el.scrollTop)
  await page.mouse.wheel(0, -300)
  await frames()
  expect(await page.locator("[data-scroller]").evaluate((el) => el.scrollTop)).toBe(mainOffset)
  expect(await page.getByText("More actions below", { exact: true }).count()).toBe(0)
  expect(await page.locator('[data-slot="process-latest"]').count()).toBe(0)
  await viewport.focus()
  await viewport.press("End")
  await page.locator('[data-slot="process-latest"]').waitFor({ state: "detached" })
  expect(await page.evaluate(() => window.__conversationProcess.retained())).toBeLessThan(120)
})

test("restoring an active process follows its current action after virtual body measurements", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => {
    window.__conversationProcess.mode("full")
    window.__conversationProcess.restoreProcess(80)
  })
  const viewport = page.locator('[data-component="process-viewport"]').last()
  await viewport.waitFor()
  for (let index = 0; index < 4; index++) await frames()
  const restored = await viewport.evaluate((element) => {
    const current = element.querySelector('[data-part-id="restored-79"]')
    const bounds = element.getBoundingClientRect()
    const row = current?.getBoundingClientRect()
    return {
      distance: element.scrollHeight - element.clientHeight - element.scrollTop,
      currentVisible: !!row && row.height > 0 && row.bottom > bounds.top && row.top < bounds.bottom,
    }
  })
  expect(restored.distance).toBeLessThanOrEqual(2)
  expect(restored.currentVisible).toBe(true)
})

for (const scenario of [
  { name: "starts with its accepted layout before new resize delivery", restores: true },
  { name: "rejects measurements from a different width", width: 350 },
  { name: "rejects measurements changed during a previous mounted resize", mountedWidth: 350, width: 700 },
]) {
  test(`a process revisit ${scenario.name}`, async () => {
    await page.goto(url)
    await page.getByText("I will check the project first.", { exact: true }).waitFor()
    await page.evaluate(() => {
      window.__conversationProcess.mode("full")
      window.__conversationProcess.grow(80)
      window.__conversationProcess.remount()
    })
    for (let index = 0; index < 4; index++) await frames()
    if (scenario.mountedWidth) {
      await page.evaluate((width) => {
        document.querySelector<HTMLElement>("[data-scroller]")!.style.width = `${width}px`
      }, scenario.mountedWidth)
      for (let index = 0; index < 4; index++) await frames()
    }
    const layout = await page.evaluate(async (width) => {
      const original = [...document.querySelectorAll<HTMLElement>('[data-component="process-viewport"]')].at(-1)!
      const height = original.querySelector<HTMLElement>('[data-slot="process-viewport-motion"] > div')!.style.height
      const first = await new Promise<string>((resolve) => {
        const observer = new MutationObserver(() => {
          const current = [...document.querySelectorAll<HTMLElement>('[data-component="process-viewport"]')].at(-1)
          if (!current || current === original) return
          const content = current.querySelector<HTMLElement>('[data-slot="process-viewport-motion"] > div')
          if (!content) return
          observer.disconnect()
          resolve(content.style.height)
        })
        observer.observe(document.getElementById("root")!, { childList: true, subtree: true })
        if (width) document.querySelector<HTMLElement>("[data-scroller]")!.style.width = `${width}px`
        window.__conversationProcess.remount()
      })
      return { height, first }
    }, scenario.width)
    if (scenario.restores) expect(layout.first).toBe(layout.height)
    else expect(layout.first).not.toBe(layout.height)
  })
}

for (const detached of [false, true]) {
  test(`same-version active body growth ${detached ? "preserves reading" : "follows the current action"} without arrival events`, async () => {
    await page.goto(url)
    await page.getByText("I will check the project first.", { exact: true }).waitFor()
    await page.evaluate(() => {
      window.__conversationProcess.mode("full")
      window.__conversationProcess.grow(40)
    })
    const viewport = page.locator('[data-component="process-viewport"]').last()
    await viewport.waitFor()
    await viewport.evaluate((element) => {
      element.scrollTop = element.scrollHeight
      element.dispatchEvent(new Event("scroll"))
    })
    for (let index = 0; index < 3; index++) await frames()
    const before = await viewport.evaluate(async (element, detached) => {
      if (detached) {
        element.dispatchEvent(new WheelEvent("wheel", { deltaY: -24, bubbles: true }))
        element.scrollTop -= 24
        element.dispatchEvent(new Event("scroll"))
      }
      const top = element.scrollTop
      const height = element.scrollHeight
      const content = element.querySelector<HTMLElement>('[data-slot="process-viewport-content"]')!
      const contentHeight = content.getBoundingClientRect().height
      const paint = new Promise<{ top: number; distance: number }>((resolve) => {
        const observer = new ResizeObserver(() => {
          if (content.getBoundingClientRect().height <= contentHeight) return
          observer.disconnect()
          requestAnimationFrame(() => {
            resolve({
              top: element.scrollTop,
              distance: element.scrollHeight - element.clientHeight - element.scrollTop,
            })
          })
        })
        observer.observe(content)
      })
      const row = element.querySelector('[data-part-id="many-39"]')!
      const lateBody = document.createElement("p")
      lateBody.textContent = "Late current-version tool content. ".repeat(200)
      row.append(lateBody)
      return { top, height, paint: await paint }
    }, detached)
    for (let index = 0; index < 5; index++) await frames()
    const after = await viewport.evaluate((element) => ({
      top: element.scrollTop,
      height: element.scrollHeight,
      distance: element.scrollHeight - element.clientHeight - element.scrollTop,
    }))
    expect(after.height).toBeGreaterThan(before.height)
    if (detached) {
      expect(Math.abs(before.paint.top - before.top)).toBeLessThanOrEqual(1)
      expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1)
    } else {
      expect(before.paint.distance).toBeLessThanOrEqual(2)
      expect(after.distance).toBeLessThanOrEqual(2)
    }
  })
}

test("a finished process can reach the end while retaining its outer conversation", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => {
    window.__conversationProcess.grow(62)
    window.__conversationProcess.mode("full")
    window.__conversationProcess.stream()
    window.__conversationProcess.complete()
  })
  await frames()
  const viewport = page.locator('[data-component="process-viewport"]').last()
  await viewport.waitFor()
  await viewport.focus()
  await page.waitForFunction(() => {
    const outer = document.querySelector<HTMLElement>("[data-scroller]")!
    const signature = `${outer.scrollTop}:${outer.scrollHeight}`
    const state = window as unknown as { settledOuter?: { signature: string; at: number } }
    if (state.settledOuter?.signature !== signature) {
      state.settledOuter = { signature, at: performance.now() }
      return false
    }
    return performance.now() - state.settledOuter.at > 200
  })
  const outerOffset = await page.locator("[data-scroller]").evaluate((element) => element.scrollTop)
  await viewport.press("End")
  await page.waitForFunction(() => {
    const item = document.querySelector('[data-part-id="many-61"]')
    const viewport = item?.closest('[data-component="process-viewport"]')
    if (!item || !viewport) return false
    const bounds = viewport.getBoundingClientRect()
    const rect = item.getBoundingClientRect()
    return rect.bottom > bounds.top && rect.top < bounds.bottom
  })
  expect(await page.locator("[data-scroller]").evaluate((element) => element.scrollTop)).toBe(outerOffset)
  expect(
    await page.locator('[data-part-id="many-61"]').evaluate((element) => {
      const bounds = element.closest('[data-component="process-viewport"]')!.getBoundingClientRect()
      const item = element.getBoundingClientRect()
      return item.bottom > bounds.top && item.top < bounds.bottom
    }),
  ).toBe(true)
  expect(await page.getByText("Final answer stays mounted.", { exact: true }).count()).toBe(1)
  expect(await page.locator('[data-component="virtual-conversation-rows"]').count()).toBe(1)
  expect(errors).toEqual([])
})

test("a process locator opens a closed group and finds an offscreen part in its own viewport", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => {
    window.__conversationProcess.grow(1000)
    window.__conversationProcess.mode("minimal")
  })
  expect(await page.evaluate(() => window.__conversationProcess.locate("more", "many-400"))).toBe(true)
  await page.waitForFunction(() => {
    const part = document.querySelector('[data-part-id="many-400"]')
    const viewport = part?.closest('[data-component="process-viewport"]')
    if (!part || !viewport) return false
    const bounds = viewport.getBoundingClientRect(),
      row = part.getBoundingClientRect()
    return row.height > 0 && row.bottom > bounds.top && row.top < bounds.bottom
  })
}, 30000)

test.each(["outer", "process"] as const)(
  "disjoint selected ranges retain only their own mounted %s rows",
  async (owner) => {
    await page.goto(owner === "outer" ? `${url}?scrolling=1&outer-paging=1` : url)
    await page.getByText("I will check the project first.", { exact: true }).waitFor()
    if (owner === "process") await page.evaluate(() => window.__conversationProcess.grow(1000))
    const viewport = page.locator(owner === "outer" ? "[data-scroller]" : '[data-component="process-viewport"]').last()
    await viewport.evaluate((element) => {
      element.style.height = "16000px"
      element.style.maxHeight = "16000px"
      element.scrollTop = 0
    })
    await page.waitForFunction((owner) => {
      const viewport = document.querySelector(
        owner === "outer" ? "[data-scroller]" : '[data-component="process-viewport"]',
      )!
      return (
        [...viewport.querySelectorAll("[data-display-row]")].filter(
          (row) => owner === "process" || !row.closest('[data-component="process-viewport"]'),
        ).length >= 9
      )
    }, owner)
    await viewport.evaluate((element, owner) => {
      const rows = [...element.querySelectorAll<HTMLElement>("[data-display-row]")]
        .filter((row) => owner === "process" || !row.closest('[data-component="process-viewport"]'))
        .slice(0, 9)
      const ranges = [
        [0, 2],
        [4, 6],
      ].map(([start, end]) => {
        const range = document.createRange()
        range.setStart(rows[start], 0)
        range.setEnd(rows[end], rows[end].childNodes.length)
        return range
      })
      window.__processSelection = rows
      // Chromium exposes one native range; real DOM Ranges exercise browsers with disjoint selections.
      Object.defineProperty(document, "getSelection", {
        configurable: true,
        value: () => ({
          rangeCount: ranges.length,
          getRangeAt: (index: number) => ranges[index],
        }),
      })
      rows[8].querySelector<HTMLElement>("button, a")?.focus({ preventScroll: true })
      document.dispatchEvent(new Event("selectionchange"))
    }, owner)
    await viewport.evaluate((element) => {
      element.style.height = "280px"
      element.style.maxHeight = "280px"
    })
    await viewport.hover()
    await page.mouse.wheel(0, 100_000)
    await page.waitForFunction(() => {
      const rows = window.__processSelection as HTMLElement[]
      return !rows[3].isConnected
    })
    expect(
      await page.evaluate(() => {
        const rows = window.__processSelection as HTMLElement[]
        return rows.map((row) => row.isConnected)
      }),
    ).toEqual([true, true, true, false, true, true, true, false, true])
    await page.evaluate(() => {
      Reflect.deleteProperty(document, "getSelection")
      ;(document.activeElement as HTMLElement)?.blur()
      document.dispatchEvent(new Event("selectionchange"))
    })
  },
  30_000,
)

test("detached reading holds the process and large blocks retain bounded mounted content", async () => {
  await page.goto(url)
  await page
    .getByText("I will check the project first.", { exact: true })
    .waitFor()
    .catch(async (error) => {
      throw new Error(JSON.stringify({ errors, html: await page.locator("#root").innerHTML() }), { cause: error })
    })
  await page.evaluate(() => {
    window.__conversationProcess.stream()
    window.__conversationProcess.reading(true)
    window.__conversationProcess.complete()
  })
  await frames()
  expect(await page.getByText("I will check the project first.", { exact: true }).count()).toBe(1)
  await page.evaluate(() => window.__conversationProcess.reading(false))
  await page.waitForFunction(() => !document.querySelector('[data-row-kind="activity"]'))
  await page.goto(url)
  await page
    .getByText("I will check the project first.", { exact: true })
    .waitFor()
    .catch(async (error) => {
      throw new Error(JSON.stringify({ errors, html: await page.locator("#root").innerHTML() }), { cause: error })
    })
  await page.evaluate(() => window.__conversationProcess.grow(1000))
  await frames()
  expect(await page.locator('[data-row-kind="activity"]').count()).toBe(2)
  expect(await page.evaluate(() => window.__conversationProcess.retained())).toBeLessThan(120)
  expect(errors).toEqual([])
}, 60000)
