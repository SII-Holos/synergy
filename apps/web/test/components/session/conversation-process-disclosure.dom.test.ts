import { expect, test } from "bun:test"
import { page, url, errors, frames, contentPage, settleConversation } from "../../support/conversation-process"

test("a reasoning item has one keyboard disclosure across streaming growth and virtual body chunks", async () => {
  await page.goto(url)
  await page.evaluate(() => window.__conversationProcess.fragments(1))
  await page.waitForFunction(() => document.querySelector('[data-part-id="summary-0"]'))
  const item = page.locator('[data-part-id="summary-0"]')
  const trigger = item.locator('[data-slot="process-reasoning-trigger"]')
  await trigger.waitFor()
  expect(await trigger.count()).toBe(1)
  await trigger.focus()
  if ((await trigger.getAttribute("aria-expanded")) === "false") {
    await page.keyboard.press("Enter")
    await page.getByText("Summary paragraph 0", { exact: true }).waitFor({ state: "visible" })
  }
  await page.keyboard.press("Enter")
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-part-id="summary-0"] [data-slot="process-reasoning-trigger"]')
        ?.getAttribute("aria-expanded") === "false",
  )
  await page.evaluate(() => window.__conversationProcess.fragments(8))
  await frames()
  expect(await trigger.count()).toBe(1)
  expect(await trigger.getAttribute("aria-expanded")).toBe("false")
  expect(await trigger.evaluate((button) => document.activeElement === button)).toBe(true)
  await page.keyboard.press("Space")
  await page.getByText("Summary paragraph 7", { exact: true }).waitFor({ state: "visible" })
  expect(await page.locator('[data-reasoning-part^="summary-"]').allTextContents()).toEqual(
    Array.from({ length: 8 }, (_, index) => `Summary paragraph ${index}`),
  )
  await settleConversation()
  const fragmentGaps = await page
    .locator('[data-reasoning-part^="summary-"]')
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
  await page.getByText("I will check the project first.", { exact: true }).waitFor({ timeout: 1000 })
  expect(await page.getByText("I will check the project first.", { exact: true }).count()).toBe(1)
}, 30000)

test("cold batch bodies reserve main-flow space without animating unfinished geometry", async () => {
  await contentPage("cold-process")
  const parent = page.locator('[data-slot="turn-process-trigger"]')
  await parent.press("Enter")
  const batch = page.locator('[data-slot="activity-batch-trigger"]')
  await batch.waitFor()
  await page.waitForFunction(() => !document.querySelector("[data-motion-changing]"))
  const result = await batch.evaluate(async (button) => {
    const animate = Element.prototype.animate
    const calls: { connected: boolean; pending: boolean }[] = []
    Element.prototype.animate = function (frames, options) {
      if (this.matches('[data-display-row][data-row-kind="body"]'))
        calls.push({ connected: this.isConnected, pending: this.hasAttribute("data-content-pending") })
      return animate.call(this, frames, options)
    }
    try {
      ;(button as HTMLButtonElement).click()
      const sizes: number[] = [],
        consumers: number[] = []
      for (let frame = 0; frame < 16; frame++) {
        await new Promise(requestAnimationFrame)
        sizes.push(
          ...[...document.querySelectorAll<HTMLElement>("[data-content-pending]")].map(
            (row) => row.getBoundingClientRect().height,
          ),
        )
        consumers.push(window.__conversationProcess.retained())
      }
      return {
        calls,
        sizes,
        consumers,
        reads: Array.from({ length: 80 }, (_, index) => window.__conversationProcess.contentReads(`cold-${index}`)),
      }
    } finally {
      Element.prototype.animate = animate
    }
  })
  expect(result.sizes.length).toBeGreaterThan(0)
  expect(Math.min(...result.sizes)).toBeGreaterThan(0)
  expect(result.calls.every((call) => call.connected && !call.pending)).toBe(true)
  expect(Math.max(...result.consumers)).toBeLessThan(120)
  expect(Math.max(...result.reads)).toBe(1)
  expect(result.reads.filter(Boolean).length).toBeLessThan(80)
  expect(await page.locator('[data-component="process-viewport"]').count()).toBe(0)
  await page.evaluate(() => {
    window.__conversationProcess.contentFinish("cold-prose")
    for (let index = 0; index < 80; index++) window.__conversationProcess.contentFinish(`cold-${index}`)
  })
  await settleConversation()
  await parent.press("Enter")
  await page.waitForFunction(() => !document.querySelector("[data-process-body]"))
  expect(await page.evaluate(() => window.__conversationProcess.retained())).toBeLessThan(8)
  expect(await page.getByText("Final answer stays mounted.", { exact: true }).count()).toBe(1)
  await parent.press("Enter")
  await settleConversation()
  expect(await page.locator('[data-part-id="cold-prose"]').count()).toBe(1)
  expect(await page.evaluate(() => window.__conversationProcess.locate("final", "answer"))).toBe(true)
  expect(await page.getByText("Final answer stays mounted.", { exact: true }).count()).toBe(1)
  expect(errors).toEqual([])
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
    expect(result.initial.length).toBeGreaterThan(0)
    expect(new Set(result.initial).size).toBe(result.initial.length)
    expect(result.evicted).toBe(true)
    expect(result.remounted).toBe(2)
    expect(result.entrances).toEqual(result.initial)
  },
)

test("warm batch disclosure animates connected body rows with accepted geometry", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  const batch = page.locator('[data-slot="activity-batch-trigger"]').last()
  await batch.click()
  await settleConversation()
  const motion = await batch.evaluate(async (button) => {
    const animate = Element.prototype.animate
    const calls: {
      connected: boolean
      height: Keyframe["height"]
      from: Keyframe["opacity"]
      to: Keyframe["opacity"]
    }[] = []
    Element.prototype.animate = function (frames, options) {
      if (this.matches('[data-display-row][data-row-kind="body"]')) {
        const values = frames as Keyframe[]
        calls.push({
          connected: this.isConnected,
          height: values[0]?.height,
          from: values[0]?.opacity,
          to: values.at(-1)?.opacity,
        })
      }
      return animate.call(this, frames, options)
    }
    try {
      ;(button as HTMLButtonElement).click()
      for (let frame = 0; frame < 4; frame++) await new Promise(requestAnimationFrame)
      return calls
    } finally {
      Element.prototype.animate = animate
    }
  })
  expect(motion.length).toBeGreaterThan(0)
  expect(
    motion.every((call) => call.connected && call.height === undefined && call.from === 0.65 && call.to === 1),
  ).toBe(true)
  await settleConversation()
  await batch.click()
  await settleConversation()
  expect(await page.locator('[data-slot="activity-step"]').count()).toBe(0)
  expect(await page.locator("[data-layout-changing]").count()).toBe(0)
  await batch.click()
  await settleConversation()
  expect(await page.locator('[data-slot="activity-step"]').count()).toBeGreaterThan(0)
}, 30000)

test("manual parent disclosure uses compositor motion without replacing the answer", async () => {
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
        space.push(frames.map((frame) => Number(frame.opacity)))
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
        changing: document.querySelectorAll("[data-motion-changing],[data-layout-changing]").length,
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
  await page.goto(`${url}?scrolling`)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => {
    window.__conversationProcess.mode("full")
    window.__conversationProcess.reasoning("Detailed reasoning paragraph.\n\n".repeat(20))
  })
  await frames()
  const located = await page.evaluate(() => window.__conversationProcess.locate("work", "thought"))
  if (!located)
    console.info(
      "reasoning Part location failed",
      await page.locator("[data-scroller]").evaluate((element) => ({
        top: element.scrollTop,
        height: element.scrollHeight,
        candidates: [...element.querySelectorAll<HTMLElement>('[data-part-id="thought"]')].map((part) => ({
          component: part.dataset.component,
          slot: part.dataset.slot,
          row: part.dataset.displayRow,
          height: part.getBoundingClientRect().height,
          top: part.getBoundingClientRect().top,
          hiddenPanel: part.closest('[data-slot="process-reasoning-panel"]')?.getAttribute("style"),
        })),
      })),
    )
  expect(located).toBe(true)
  await settleConversation()
  const viewport = page.locator("[data-scroller]")
  const trigger = viewport.locator('[data-slot="process-reasoning-trigger"]').first()
  await trigger.waitFor()
  if ((await trigger.getAttribute("aria-expanded")) === "true") await trigger.click()
  await settleConversation()
  const samples = await viewport.evaluate(async (el) => {
    const viewport = el as HTMLElement
    const trigger = viewport.querySelector<HTMLButtonElement>('[data-slot="process-reasoning-trigger"]')!
    const initial = { width: viewport.clientWidth, top: trigger.getBoundingClientRect().top }
    trigger.click()
    const values = []
    for (let index = 0; index < 35; index++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      values.push({
        width: viewport.clientWidth,
        connected: trigger.isConnected,
        visible:
          trigger.getBoundingClientRect().bottom > viewport.getBoundingClientRect().top &&
          trigger.getBoundingClientRect().top < viewport.getBoundingClientRect().bottom,
        drift: trigger.getBoundingClientRect().top - initial.top,
      })
    }
    return { initial, values }
  })
  for (const sample of samples.values) {
    expect(sample.width).toBe(samples.initial.width)
    expect(sample.connected).toBe(true)
    expect(sample.visible).toBe(true)
    expect(Math.abs(sample.drift)).toBeLessThanOrEqual(1)
  }
  await settleConversation()
  expect(await page.locator("[data-layout-changing]").count()).toBe(0)
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
          '[data-display-row], [data-slot="activity-batch-content"], [data-slot="activity-step"], [data-slot="session-turn-timeline-item"]',
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
      await page.goto(`${url}?scrolling`)
      await page.getByText("I will check the project first.", { exact: true }).waitFor()
      await page.evaluate((width) => {
        ;(document.querySelector("[data-scroller]") as HTMLElement).style.width = `${width}px`
        window.__conversationProcess.mode("full")
        window.__conversationProcess.reasoning("Long reasoning.\n\n".repeat(100))
      }, width)
      await frames()
      expect(await page.evaluate(() => window.__conversationProcess.locate("work", "thought"))).toBe(true)
      await settleConversation()
      const viewport = page.locator("[data-scroller]")
      const geometry = await viewport.evaluate(async (el) => {
        const viewport = el as HTMLElement,
          trigger = viewport.querySelector<HTMLButtonElement>('[data-slot="process-reasoning-trigger"]')!
        const width = viewport.clientWidth
        if (trigger.getAttribute("aria-expanded") === "true") trigger.click()
        for (let index = 0; index < 6; index++) trigger.click()
        const height = viewport.clientHeight
        trigger.click()
        for (let index = 0; index < 8; index++)
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        return {
          width,
          after: viewport.clientWidth,
          height: viewport.clientHeight,
          animations: viewport.getAnimations({ subtree: true }).length,
          originalHeight: height,
          expanded: trigger.getAttribute("aria-expanded"),
          changing: document.querySelectorAll("[data-motion-changing],[data-layout-changing]").length,
        }
      })
      expect(geometry.after).toBe(geometry.width)
      expect(geometry.height).toBe(geometry.originalHeight)
      expect(geometry.animations).toBe(0)
      expect(geometry.expanded).toBe("true")
      expect(geometry.changing).toBe(0)
      expect(await page.locator('[data-component="process-viewport"]').count()).toBe(0)
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

test("live count updates keep the existing fact and number elements mounted", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  const result = await page.evaluate(async () => {
    const title = () => [...document.querySelectorAll('[data-component="conversation-activity"] > button')].at(-1)!
    const fact = title().querySelector('[data-activity-fact="execute"]')!
    const number = fact.querySelector('[data-component="animated-activity-count"]')!
    const before = number.getAttribute("aria-label")
    window.__conversationProcess.append("next-count")
    for (let index = 0; index < 3; index++) await new Promise(requestAnimationFrame)
    return {
      fact: title().querySelector('[data-activity-fact="execute"]') === fact,
      number: title().querySelector('[data-component="animated-activity-count"]') === number,
      before,
      after: number.getAttribute("aria-label"),
    }
  })
  expect(result.fact).toBe(true)
  expect(result.number).toBe(true)
  expect(result.after).not.toBe(result.before)
})

test("batch layout commits once while the retained answer moves smoothly on the compositor", async () => {
  await page.goto(`${url}?scrolling`)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => {
    window.__conversationProcess.grow(5)
    window.__conversationProcess.stream()
    window.__conversationProcess.complete()
  })
  await page.locator('[data-slot="turn-process-trigger"]').press("Enter")
  await settleConversation()
  const batch = page.locator('[data-slot="activity-batch-trigger"]').last()
  const result = await batch.evaluate(async (button) => {
    const answer = document.querySelector<HTMLElement>('[data-part-id="answer"]')!
    const wrapper = answer.parentElement!
    const original = answer.getBoundingClientRect().top
    const animate = Element.prototype.animate
    const sizes: number[] = [],
      positions: number[] = [],
      layout: string[] = []
    Element.prototype.animate = function (frames, options) {
      if (this.matches("[data-display-row]") && Array.isArray(frames))
        sizes.push(...frames.flatMap((frame) => (frame.height === undefined ? [] : [Number(frame.height)])))
      return animate.call(this, frames, options)
    }
    try {
      ;(button as HTMLButtonElement).click()
      for (let frame = 0; frame < 24; frame++) {
        await new Promise(requestAnimationFrame)
        if (!answer.isConnected) throw new Error("Retained answer detached during disclosure")
        positions.push(answer.getBoundingClientRect().top)
        layout.push(wrapper.style.top)
      }
      return { original, positions, layout, sizes }
    } finally {
      Element.prototype.animate = animate
    }
  })
  expect(result.sizes).toEqual([])
  expect(new Set(result.layout.slice(2)).size).toBe(1)
  const last = result.positions.at(-1)!
  expect(last - result.original).toBeGreaterThan(100)
  expect(result.positions.some((top) => top > result.original + 2 && top < last - 2)).toBe(true)
  await settleConversation()
  expect(await page.locator("[data-layout-changing]").count()).toBe(0)
})

test("reasoning disclosure changes measured layout once and releases movement on collapse", async () => {
  await page.goto(`${url}?scrolling`)
  await page.evaluate(() => {
    window.__conversationProcess.fragments(6)
    window.__conversationProcess.stream()
    window.__conversationProcess.complete()
  })
  await page.locator('[data-slot="turn-process-trigger"]').press("Enter")
  await settleConversation()
  const batch = page.locator('[data-slot="activity-batch-trigger"]').last()
  if ((await batch.getAttribute("aria-expanded")) === "false") await batch.click()
  await settleConversation()
  const trigger = page.locator('[data-slot="process-reasoning-trigger"]').first()
  const sample = () =>
    trigger.evaluate(async (button) => {
      const animate = Element.prototype.animate
      const heights: string[] = []
      const offsets: string[] = []
      const answer = document.querySelector<HTMLElement>('[data-part-id="answer"]')!
      const wrapper = answer.parentElement!
      Element.prototype.animate = function (frames, options) {
        if (this.matches('[data-slot="process-reasoning-panel"]') && Array.isArray(frames))
          heights.push(...frames.flatMap((frame) => (frame.height === undefined ? [] : [String(frame.height)])))
        return animate.call(this, frames, options)
      }
      try {
        ;(button as HTMLButtonElement).click()
        for (let frame = 0; frame < 48; frame++) {
          await new Promise(requestAnimationFrame)
          if (!answer.isConnected) throw new Error("Reading answer detached during reasoning disclosure")
          offsets.push(wrapper.style.top)
        }
        return { heights, offsets }
      } finally {
        Element.prototype.animate = animate
      }
    })
  for (const opening of [true, false]) {
    const result = await sample()
    expect(result.heights).toEqual([])
    expect(new Set(result.offsets.slice(2)).size).toBeLessThanOrEqual(opening ? 1 : 2)
    await settleConversation()
    expect(await page.locator("[data-layout-changing]").count()).toBe(0)
  }
})

test.each(["wheel", "keyboard"])("native %s input releases disclosure movement before reading", async (input) => {
  await page.goto(`${url}?scrolling`)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => {
    window.__conversationProcess.grow(5)
    window.__conversationProcess.stream()
    window.__conversationProcess.complete()
  })
  await page.locator('[data-slot="turn-process-trigger"]').press("Enter")
  await settleConversation()
  await page
    .locator('[data-component="virtual-conversation-rows"]')
    .evaluate((element) => (element as HTMLElement).style.setProperty("--motion-duration-base", "600ms"))
  await page
    .locator('[data-slot="activity-batch-trigger"]')
    .last()
    .evaluate((element) => (element as HTMLButtonElement).click())
  await page.locator("[data-layout-changing]").first().waitFor({ state: "attached" })
  const viewport = page.locator("[data-scroller]")
  if (input === "wheel") {
    await viewport.hover()
    await page.mouse.wheel(0, 80)
  } else {
    await viewport.focus()
    await page.keyboard.press("PageDown")
  }
  await page.waitForFunction(() => !document.querySelector("[data-layout-changing]"), undefined, { timeout: 300 })
  await settleConversation()
  expect(errors).toEqual([])
})

test("compact activity titles retain successful facts while showing current runtime activity", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  const titles = page.locator('[data-component="conversation-activity"] > [data-slot="activity-batch-trigger"]')
  const latest = titles.last()
  const status = latest.locator('[data-slot="activity-batch-status"]')
  const waitForStatus = (label: string) =>
    page.waitForFunction(
      (label) =>
        [...document.querySelectorAll('[data-slot="activity-batch-status"]')].some((node) =>
          node.textContent?.includes(label),
        ),
      label,
    )
  expect(await status.count()).toBe(1)
  expect(await status.textContent()).toContain("Waiting for model response")
  expect(await latest.textContent()).toContain("Ran 2 commands")
  expect(await titles.first().locator('[data-slot="activity-batch-status"]').count()).toBe(0)
  await page.evaluate(() => {
    window.__activityTitle = document.querySelectorAll('[data-component="conversation-activity"] > button').item(1)
    window.__activityFacts = window.__activityTitle?.firstElementChild
    window.__conversationProcess.phase({
      phase: "running_tools",
      startedAt: 2,
      rootID: "root",
      tool: { id: "read", count: 1 },
    })
  })
  await waitForStatus("Calling tool")
  expect(await status.textContent()).toContain("Calling tool")
  expect(await page.evaluate(() => window.__activityTitle?.firstElementChild === window.__activityFacts)).toBe(true)
  const animation = () =>
    status.locator('[data-slot="activity-batch-status-text"]').evaluate((el) => getComputedStyle(el).animationName)
  expect(await animation()).not.toBe("none")
  await page.evaluate(() => window.__conversationProcess.approval(true))
  await waitForStatus("Waiting for your approval")
  expect(await status.textContent()).toContain("Waiting for your approval")
  expect(await animation()).toBe("none")
  await page.evaluate(() => {
    window.__conversationProcess.approval(false)
    window.__conversationProcess.connected(false)
  })
  await waitForStatus("Reconnecting")
  expect(await status.textContent()).toContain("Reconnecting")
  expect(await animation()).toBe("none")
  await page.evaluate(() => {
    window.__conversationProcess.connected(true)
    window.__conversationProcess.phase({ phase: "stopping", startedAt: 3, rootID: "root" })
  })
  await waitForStatus("Stopping")
  expect(await status.textContent()).toContain("Stopping")
  expect(await animation()).toBe("none")
  await page.evaluate(() =>
    window.__conversationProcess.phase({ phase: "waiting_model", startedAt: 4, rootID: "root" }),
  )
  await page.emulateMedia({ reducedMotion: "reduce" })
  try {
    await waitForStatus("Waiting for model response")
    expect(await status.textContent()).toContain("Waiting for model response")
    expect(await animation()).toBe("none")
  } finally {
    await page.emulateMedia({ reducedMotion: "no-preference" })
  }
  await page.evaluate(() => {
    window.__conversationProcess.stream()
    window.__conversationProcess.complete()
  })
  await frames()
  expect(await page.locator('[data-slot="activity-batch-status"]').count()).toBe(0)
})
