import { expect, test } from "bun:test"
import { page, url, errors, frames, contentPage } from "../../support/conversation-process"

test("a reasoning item has one keyboard disclosure across streaming growth and virtual body chunks", async () => {
  await page.goto(url)
  await page.evaluate(() => window.__conversationProcess.fragments(1))
  const trigger = page.locator('[data-slot="process-reasoning-trigger"]')
  await trigger.waitFor()
  expect(await trigger.count()).toBe(1)
  await trigger.focus()
  if ((await trigger.getAttribute("aria-expanded")) === "false") {
    await page.keyboard.press("Enter")
    await page.getByText("Summary paragraph 0", { exact: true }).waitFor({ state: "visible" })
  }
  await page.keyboard.press("Enter")
  await page.waitForFunction(
    () => document.querySelector('[data-slot="process-reasoning-trigger"]')?.getAttribute("aria-expanded") === "false",
  )
  await page.evaluate(() => window.__conversationProcess.fragments(8))
  await frames()
  expect(await trigger.count()).toBe(1)
  expect(await trigger.getAttribute("aria-expanded")).toBe("false")
  expect(await trigger.evaluate((button) => document.activeElement === button)).toBe(true)
  await page.keyboard.press("Space")
  await page.getByText("Summary paragraph 7", { exact: true }).waitFor({ state: "visible" })
  expect(await page.locator("[data-reasoning-part]").allTextContents()).toEqual(
    Array.from({ length: 8 }, (_, index) => `Summary paragraph ${index}`),
  )
  await page.waitForFunction(
    () => !document.querySelector('[data-slot="process-reasoning-panel"][data-motion-changing]'),
  )
  const fragmentGaps = await page
    .locator("[data-reasoning-part]")
    .evaluateAll((parts) =>
      parts
        .slice(1)
        .map((part, index) => part.getBoundingClientRect().top - parts[index].getBoundingClientRect().bottom),
    )
  for (const gap of fragmentGaps) expect(Math.abs(gap - 8)).toBeLessThanOrEqual(1)
  const ids = await page
    .locator('[data-slot="process-reasoning-detail"]')
    .evaluateAll((panels) => panels.map((panel) => panel.id))
  expect(new Set(ids).size).toBe(ids.length)
  for (const mode of ["full", "minimal", "balanced"] as const) {
    await page.evaluate((mode) => window.__conversationProcess.mode(mode), mode)
    await frames()
    expect(await trigger.count()).toBe(1)
    expect(await trigger.getAttribute("aria-expanded")).toBe("true")
  }
  await trigger.click()
  await page.getByText("Summary paragraph 7", { exact: true }).waitFor({ state: "hidden" })
}, 30000)

test("parent and batch disclosures preserve independent choices and tool inspection", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => {
    window.__conversationProcess.grow(20)
    window.__conversationProcess.stream()
    window.__conversationProcess.complete()
  })
  await page.waitForFunction(() => !document.querySelector('[data-row-kind="activity"]'))
  const trigger = page.locator('[data-slot="turn-process-trigger"]')
  await trigger.press("Enter")
  await frames()
  const batches = page.locator('[data-component="conversation-activity"] > button')
  expect(await batches.count()).toBe(2)
  expect(await batches.last().getAttribute("aria-expanded")).toBe("false")
  expect(await page.locator('[data-slot="activity-step-trigger"]').count()).toBe(0)
  await batches.last().press("Enter")
  const tool = page.locator('[data-slot="activity-step-trigger"]').first()
  await tool.waitFor()
  expect(await tool.textContent()).toContain("pwd")
  expect(await tool.textContent()).not.toContain("Check the project directory")
  await tool.click()
  expect(await page.evaluate(() => window.__processSelection)).toMatchObject({
    sessionID: "session",
    messageID: "work",
    partID: "command-0",
    callID: "command-0",
  })
  expect(await page.getByRole("dialog").count()).toBe(0)
  await trigger.press("Enter")
  await page.waitForFunction(() => !document.querySelector('[data-row-kind="activity"]'))
  await trigger.press("Enter")
  await tool.waitFor()
  expect(await batches.first().getAttribute("aria-expanded")).toBe("false")
  expect(await batches.last().getAttribute("aria-expanded")).toBe("true")
  await batches.last().press("Space")
  await page.waitForFunction(() => !document.querySelector('[data-slot="activity-step-trigger"]'))
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  expect(await page.getByText("I will check the project first.", { exact: true }).count()).toBe(1)
}, 30000)

test("cold process disclosure keeps a bounded reading window while tool bodies are pending", async () => {
  await contentPage("cold-process")
  await page.evaluate(() => {
    const animate = Element.prototype.animate
    Element.prototype.animate = function (frames, options) {
      if (this.matches('[data-display-row][data-row-kind="activity"]'))
        this.setAttribute("data-test-entrances", String(Number(this.getAttribute("data-test-entrances")) + 1))
      return animate.call(this, frames, options)
    }
  })
  const parent = page.locator('[data-slot="turn-process-trigger"]')
  await parent.waitFor()
  await parent.press("Enter")
  const batch = page.locator('[data-component="conversation-activity"] > button')
  await batch.waitFor()
  await page.waitForFunction(() => !document.querySelector("[data-motion-changing]"))
  expect(
    await batch.evaluate((element) => element.closest("[data-display-row]")?.getAttribute("data-test-entrances")),
  ).toBe("1")
  await batch.press("Enter")
  const viewport = page.locator('[data-component="process-viewport"]')
  await viewport.waitFor()
  const pending = await page.evaluate(async () => {
    const sizes: number[] = []
    for (let frame = 0; frame < 12; frame++) {
      await new Promise(requestAnimationFrame)
      const viewport = document.querySelector('[data-component="process-viewport"]')!
      sizes.push(viewport.getBoundingClientRect().height)
    }
    return {
      sizes,
      reads: Array.from({ length: 80 }, (_, index) => window.__conversationProcess.contentReads(`cold-${index}`)),
      retained: window.__conversationProcess.retained(),
    }
  })
  expect(Math.min(...pending.sizes)).toBeGreaterThan(200)
  expect(pending.reads.filter(Boolean).length).toBeLessThan(48)
  expect(Math.max(...pending.reads)).toBe(1)
  expect(pending.retained).toBeLessThan(48)
  await page.evaluate(() => {
    for (let index = 0; index < 80; index++) window.__conversationProcess.contentFinish(`cold-${index}`)
  })
  await page.locator('[data-slot="activity-step-trigger"]').first().waitFor()
  expect(
    await batch.evaluate((element) => element.closest("[data-display-row]")?.getAttribute("data-test-entrances")),
  ).toBe("1")
  expect(await viewport.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(200)
  expect(await page.getByText("Final answer stays mounted.", { exact: true }).count()).toBe(1)
  await batch.press("Enter")
  await viewport.waitFor({ state: "detached" })
  expect(await page.evaluate(() => window.__conversationProcess.retained())).toBeLessThan(8)
  const contraction = await page.evaluate(async () => {
    const pending = document.querySelector<HTMLElement>('[data-part-id="cold-prose"]')!
    const before = pending.getBoundingClientRect().height
    document.querySelector<HTMLButtonElement>('[data-slot="turn-process-trigger"]')!.click()
    for (let frame = 0; frame < 8; frame++) await new Promise(requestAnimationFrame)
    return { before, during: pending.getBoundingClientRect().height, connected: pending.isConnected }
  })
  expect(contraction.connected).toBe(true)
  expect(contraction.during).toBeGreaterThan(0)
  expect(contraction.during).toBeLessThan(contraction.before - 2)
  await parent.press("Enter")
  await page.waitForFunction(() => !document.querySelector("[data-motion-changing]"))
  expect(await page.locator('[data-part-id="cold-prose"]').count()).toBe(1)
})

test.each(["initial", "reversed"])(
  "virtual eviction before manual entrance settles cannot replay it (%s)",
  async (mode) => {
    const reverse = mode === "reversed"
    await page.goto(url)
    await page.getByText("I will check the project first.", { exact: true }).waitFor()
    await page.evaluate(() => {
      window.__conversationProcess.stream()
      window.__conversationProcess.complete()
      window.__conversationProcess.prependTurns(80)
      window.__conversationProcess.reading(true)
      const scroller = document.querySelector<HTMLElement>("[data-scroller]")!
      scroller.scrollTop = scroller.scrollHeight
    })
    const parent = page.locator('[data-slot="turn-process-trigger"]').last()
    await parent.waitFor()
    if ((await parent.getAttribute("aria-expanded")) === "true") await parent.click()
    await page.waitForFunction(() => !document.querySelector("[data-motion-changing]"))
    const result = await page.evaluate(async (reverse) => {
      const entrances: string[] = []
      const animate = Element.prototype.animate
      const settle = async () => {
        for (let frame = 0; frame < 20; frame++) await new Promise(requestAnimationFrame)
      }
      Element.prototype.animate = function (frames, options) {
        if (this.matches('[data-display-row][data-turn-root="root"]')) {
          entrances.push((this as HTMLElement).dataset.displayRow!)
          return animate.call(this, frames, { ...(typeof options === "object" ? options : {}), duration: 5000 })
        }
        return animate.call(this, frames, options)
      }
      try {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        document.querySelector<HTMLButtonElement>('[data-turn-root="root"] [data-slot="turn-process-trigger"]')!.click()
        await settle()
        if (reverse) {
          const parent = document.querySelector<HTMLButtonElement>(
            '[data-turn-root="root"] [data-slot="turn-process-trigger"]',
          )!
          parent.click()
          parent.click()
          await settle()
        }
        const initial = [...entrances]
        const bodies = [
          ...document.querySelectorAll(
            '[data-turn-root="root"][data-process-body], [data-turn-root="root"][data-row-kind="activity"]',
          ),
        ]
        const scroller = document.querySelector<HTMLElement>("[data-scroller]")!
        scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -10000, bubbles: true }))
        scroller.scrollTop = 0
        await settle()
        const evicted = bodies.some((element) => !element.isConnected)
        scroller.scrollTop = scroller.scrollHeight
        await settle()
        return {
          initial,
          entrances,
          evicted,
          remounted: document.querySelectorAll('[data-turn-root="root"][data-row-kind="activity"]').length,
        }
      } finally {
        Element.prototype.animate = animate
      }
    }, reverse)
    expect(result.initial).toHaveLength(3)
    expect(new Set(result.initial).size).toBe(3)
    expect(result.evicted).toBe(true)
    expect(result.remounted).toBe(2)
    expect(result.entrances).toEqual(result.initial)
  },
)

test("manual disclosure animates only its connected mount and releases it on collapse", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  const batch = page.locator('[data-component="conversation-activity"] > button').first()
  if ((await batch.getAttribute("aria-expanded")) === "true") await batch.press("Enter")
  await page
    .locator('[data-component="conversation-activity"]')
    .first()
    .locator('[data-slot="activity-batch-content"]')
    .waitFor({ state: "detached" })
  const result = await page.evaluate(async () => {
    const button = document.querySelector<HTMLButtonElement>('[data-component="conversation-activity"] > button')!
    const animate = Element.prototype.animate
    const matchMedia = window.matchMedia
    let listeners = 0
    window.matchMedia = (query) => {
      const media = matchMedia.call(window, query)
      const add = media.addEventListener.bind(media)
      const remove = media.removeEventListener.bind(media)
      media.addEventListener = (...args: Parameters<typeof add>) => {
        if (args[0] === "change") listeners++
        add(...args)
      }
      media.removeEventListener = (...args: Parameters<typeof remove>) => {
        if (args[0] === "change") listeners--
        remove(...args)
      }
      return media
    }
    const calls: { connected: boolean; height: number[] }[] = []
    Element.prototype.animate = function (frames, options) {
      if (this.matches('[data-slot="activity-batch-content"]'))
        calls.push({
          connected: this.isConnected,
          height: Array.isArray(frames) ? frames.map((frame) => parseFloat(String(frame.height))) : [],
        })
      return animate.call(this, frames, options)
    }
    const settle = async () => {
      for (let frame = 0; frame < 36; frame++) await new Promise(requestAnimationFrame)
    }
    try {
      button.click()
      await settle()
      const openedListeners = listeners
      button.click()
      await settle()
      const closedListeners = listeners
      button.click()
      await settle()
      return {
        calls,
        openedListeners,
        closedListeners,
        reopenedListeners: listeners,
        open: button.getAttribute("aria-expanded"),
        mounted: !!button.parentElement?.querySelector('[data-slot="activity-batch-content"]'),
      }
    } finally {
      Element.prototype.animate = animate
      window.matchMedia = matchMedia
    }
  })
  expect(result.calls.map((call) => call.connected)).toEqual([true, true, true])
  for (const call of result.calls) {
    expect(call.height).toHaveLength(2)
    expect(call.height.every(Number.isFinite)).toBe(true)
    expect(Math.max(...call.height)).toBeGreaterThan(0)
    expect(Math.min(...call.height)).toBe(0)
  }
  expect(result.open).toBe("true")
  expect(result.mounted).toBe(true)
  expect(result.openedListeners).toBeGreaterThan(0)
  expect(result.closedListeners).toBe(0)
  expect(result.reopenedListeners).toBe(result.openedListeners)
}, 30000)

test("manual parent disclosure owns bounded space motion without replacing the answer", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => {
    window.__conversationProcess.stream()
    window.__conversationProcess.complete()
  })
  await page.waitForFunction(() => !document.querySelector('[data-row-kind="activity"]'))
  const result = await page.evaluate(async () => {
    const parent = document.querySelector<HTMLButtonElement>('[data-slot="turn-process-trigger"]')!
    const answer = document.querySelector('[data-part-id="answer"]')
    const animate = Element.prototype.animate
    const space: number[][] = []
    Element.prototype.animate = function (frames, options) {
      if (this.matches("[data-display-row]") && Array.isArray(frames))
        space.push(frames.map((frame) => parseFloat(String(frame.height))))
      return animate.call(this, frames, options)
    }
    const settle = async (count = 36) => {
      for (let frame = 0; frame < count; frame++) await new Promise(requestAnimationFrame)
    }
    try {
      parent.click()
      await settle()
      parent.click()
      await settle(3)
      parent.click()
      await settle()
      return {
        space,
        open: parent.getAttribute("aria-expanded"),
        activities: document.querySelectorAll('[data-row-kind="activity"]').length,
        sameAnswer: answer === document.querySelector('[data-part-id="answer"]'),
        changing: document.querySelectorAll("[data-motion-changing]").length,
      }
    } finally {
      Element.prototype.animate = animate
    }
  })
  expect(result.space.length).toBeGreaterThan(0)
  expect(result.space.every((frames) => frames.length === 2 && frames.every(Number.isFinite))).toBe(true)
  expect(result.open).toBe("true")
  expect(result.activities).toBe(2)
  expect(result.sameAnswer).toBe(true)
  expect(result.changing).toBe(0)
}, 30000)

test("disclosure across the overflow threshold preserves width and the clicked reading position", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => window.__conversationProcess.mode("full"))
  const viewport = page.locator('[data-component="process-viewport"]').first()
  const trigger = viewport.locator('[data-slot="process-reasoning-trigger"]').first()
  await trigger.waitFor()
  if ((await trigger.getAttribute("aria-expanded")) === "true") await trigger.click()
  await page.waitForTimeout(300)
  await page.locator("[data-scroller]").evaluate((el) => ((el as HTMLElement).style.height = "1200px"))
  await page.evaluate(() => window.__conversationProcess.reasoning("Detailed reasoning paragraph.\n\n".repeat(20)))
  await frames()
  const samples = await viewport.evaluate(async (el) => {
    const viewport = el as HTMLElement
    viewport.style.maxHeight = `${viewport.clientHeight + 2}px`
    const trigger = viewport.querySelector<HTMLButtonElement>('[data-slot="process-reasoning-trigger"]')!
    const initial = { width: viewport.clientWidth, top: trigger.getBoundingClientRect().top }
    trigger.click()
    const values = []
    for (let index = 0; index < 35; index++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      values.push({
        width: viewport.clientWidth,
        gap: viewport.parentElement!.getBoundingClientRect().height - viewport.getBoundingClientRect().height,
        drift: trigger.getBoundingClientRect().top - initial.top,
      })
    }
    return { initial, values }
  })
  for (const sample of samples.values) {
    expect(sample.width).toBe(samples.initial.width)
    expect(Math.abs(sample.gap)).toBeLessThanOrEqual(1)
    expect(Math.abs(sample.drift)).toBeLessThanOrEqual(1)
  }
})

test("remounting existing process content does not replay entrance animations", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  const entrances = await page.evaluate(async () => {
    const animate = Element.prototype.animate
    let entrances = 0
    Element.prototype.animate = function (...args) {
      if (
        this.matches(
          '[data-slot="activity-batch-content"], [data-slot="activity-step"], [data-slot="session-turn-timeline-item"]',
        )
      )
        entrances++
      return animate.apply(this, args)
    }
    try {
      window.__conversationProcess.remount()
      for (let index = 0; index < 20; index++)
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      return entrances
    } finally {
      Element.prototype.animate = animate
    }
  })
  expect(entrances).toBe(0)
})

test("narrow columns and reduced motion preserve geometry through rapid reversal", async () => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  try {
    for (const width of [320, 375]) {
      await page.goto(url)
      await page.getByText("I will check the project first.", { exact: true }).waitFor()
      await page.evaluate((width) => {
        ;(document.querySelector("[data-scroller]") as HTMLElement).style.width = `${width}px`
        window.__conversationProcess.mode("full")
        window.__conversationProcess.reasoning("Long reasoning.\n\n".repeat(100))
      }, width)
      const viewport = page.locator('[data-component="process-viewport"]').first()
      const geometry = await viewport.evaluate(async (el) => {
        const viewport = el as HTMLElement,
          trigger = viewport.querySelector<HTMLButtonElement>('[data-slot="process-reasoning-trigger"]')!
        const width = viewport.clientWidth
        for (let index = 0; index < 6; index++) trigger.click()
        trigger.click()
        for (let index = 0; index < 8; index++)
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        return {
          width,
          after: viewport.clientWidth,
          height: viewport.clientHeight,
          animations: viewport.getAnimations({ subtree: true }).length,
        }
      })
      expect(geometry.after).toBe(geometry.width)
      expect(geometry.height).toBeLessThanOrEqual(240)
      expect(geometry.animations).toBe(0)
    }
  } finally {
    await page.emulateMedia({ reducedMotion: "no-preference" })
  }
})

test("focusing a closed process header preserves its state until the first explicit activation", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => window.__conversationProcess.mode("minimal"))
  const trigger = page.locator('[data-slot="turn-process-trigger"]')
  await trigger.waitFor()
  expect(await trigger.getAttribute("aria-expanded")).toBe("false")
  await trigger.focus()
  await frames()
  expect(await trigger.getAttribute("aria-expanded")).toBe("false")
  await trigger.press("Enter")
  await frames()
  expect(await trigger.getAttribute("aria-expanded")).toBe("true")
  await trigger.click()
  await frames()
  expect(await trigger.getAttribute("aria-expanded")).toBe("false")
  expect(errors).toEqual([])
}, 30000)
