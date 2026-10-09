import { afterAll, beforeAll, expect, test } from "bun:test"
import {
  browser,
  page,
  url,
  errors,
  observeResizeErrors,
  fixtureServer,
  frames,
  settleConversation,
} from "../../support/conversation-process"

let alternate: Awaited<ReturnType<typeof fixtureServer>>
beforeAll(async () => {
  alternate = await fixtureServer("index.jsx")
}, 90000)
afterAll(async () => {
  await alternate?.close()
})

test("expanded transcript records allocate no nested scroll readers", async () => {
  const target = await browser.newPage()
  try {
    await target.addInitScript(() => {
      const listeners: EventTarget[] = []
      const observations: Element[] = []
      const add = EventTarget.prototype.addEventListener
      EventTarget.prototype.addEventListener = function (type, listener, options) {
        if (type === "wheel") listeners.push(this)
        return add.call(this, type, listener, options)
      }
      const observe = ResizeObserver.prototype.observe
      ResizeObserver.prototype.observe = function (element, options) {
        observations.push(element)
        return observe.call(this, element, options)
      }
      Object.assign(window, { scrollSurfaces: { listeners, observations } })
    })
    await target.goto(url)
    await target.getByText("I will check the project first.", { exact: true }).waitFor()
    await target.evaluate(() => {
      window.__conversationProcess.mode("full")
      window.__conversationProcess.grow(1000)
    })
    expect(await target.evaluate(() => window.__conversationProcess.locate("more", "many-400"))).toBe(true)
    await target.locator('[data-slot="activity-step-trigger"]').first().waitFor()
    const readers = await target.evaluate(() => {
      const surfaces = (window as unknown as { scrollSurfaces: { listeners: EventTarget[]; observations: Element[] } })
        .scrollSurfaces
      return {
        input: surfaces.listeners.filter(
          (element) => element instanceof Element && element.matches('[data-slot="session-turn-content"]'),
        ).length,
        measurement: surfaces.observations.filter((element) =>
          element.matches('[data-slot="session-turn-message-container"]'),
        ).length,
      }
    })
    expect(readers).toEqual({ input: 0, measurement: 0 })
  } finally {
    await target.close()
  }
})

test("compact records consume their turn status without resolving it per tool", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => window.__conversationProcess.grow(1000))
  expect(await page.evaluate(() => window.__conversationProcess.locate("more", "many-0"))).toBe(true)
  await settleConversation()
  const batch = page.locator('[data-slot="activity-batch-trigger"]').last()
  if ((await batch.getAttribute("aria-expanded")) === "true") {
    await batch.click()
    await settleConversation()
  }
  const before = await page.evaluate(() => window.__conversationProcess.statusReads())
  await batch.click()
  await settleConversation()
  expect(await page.locator('[data-slot="activity-step"]').count()).toBeGreaterThan(4)
  expect((await page.evaluate(() => window.__conversationProcess.statusReads())) - before).toBeLessThanOrEqual(10)
})

test("focus outside a large conversation does not reread its summaries", async () => {
  await page.goto(`${url}?scrolling`)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => window.__conversationProcess.grow(1000))
  await frames()
  await settleConversation()
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
  await settleConversation()
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
    const target = entry === "index.jsx" ? await browser.newPage() : page
    target.setDefaultTimeout(15000)
    if (entry === "index.jsx") target.on("pageerror", (error) => errors.push(error.message))
    try {
      await target.goto(`${entry === "index.jsx" ? alternate.url : url}resize.html?fixed`)
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
      if (entry === "index.jsx") await target.close()
    }
  },
  30000,
)

test.each(["index.mjs", "index.jsx"] as const)(
  "history hydration, hidden lists and process disclosure retain measured geometry (%s)",
  async (entry) => {
    const target = entry === "index.jsx" ? await browser.newPage() : page
    target.setDefaultTimeout(15000)
    if (entry === "index.jsx") target.on("pageerror", (error) => errors.push(error.message))
    await observeResizeErrors(target)
    try {
      const base = entry === "index.jsx" ? alternate.url : url
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
      await target.goto(base)
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
      await target.locator('[data-slot="activity-step-trigger"]').first().waitFor()
      expect(await target.locator('[data-component="process-viewport"]').count()).toBe(0)
      await target.waitForFunction(() => !document.querySelector("[data-motion-changing]"))
      await batch.press("Enter")
      await target.waitForFunction(() => !document.querySelector('[data-slot="activity-step-trigger"]'))
      await batch.press("Enter")
      await target.locator('[data-slot="activity-step-trigger"]').first().waitFor()
      expect(await target.evaluate(() => window.__conversationProcess.retained())).toBeLessThan(120)
      expect(await target.evaluate(() => window.__resizeErrors)).toEqual([])
    } finally {
      if (entry === "index.jsx") await target.close()
    }
  },
  60000,
)

test("repeated process reading input does not rebuild unchanged conversation summaries", async () => {
  await page.goto(`${url}?scrolling`)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => window.__conversationProcess.grow(600))
  await page.evaluate(() => window.__conversationProcess.locate("work", "command-0"))
  const batch = page.locator('[data-slot="activity-batch-trigger"]').last()
  await batch.click()
  await batch.click()
  const viewport = page.locator("[data-scroller]").last()
  await viewport.waitFor()
  await viewport.dispatchEvent("wheel", { deltaY: -1 })
  await frames()
  await frames()
  await settleConversation()
  const before = await page.evaluate(() => window.__conversationProcess.summaryReads())
  for (let index = 0; index < 6; index++) {
    await viewport.dispatchEvent("wheel", { deltaY: -1 })
    await frames()
  }
  expect(await page.evaluate(() => window.__conversationProcess.summaryReads())).toBe(before)
  expect(errors).toEqual([])
})

test("tool batches share the conversation reader and keep large histories virtualized", async () => {
  await page.goto(`${url}?scrolling`)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => window.__conversationProcess.grow(1000))
  await frames()
  expect(await page.locator('[data-component="process-viewport"]').count()).toBe(0)
  expect(await page.locator('[data-slot="activity-step-trigger"]').count()).toBeGreaterThan(0)
  expect(await page.evaluate(() => window.__conversationProcess.retained())).toBeLessThan(120)
  const reader = page.locator("[data-scroller]")
  await reader.hover()
  const before = await reader.evaluate((element) => element.scrollTop)
  await page.mouse.wheel(0, -300)
  await frames()
  expect(await reader.evaluate((element) => element.scrollTop)).toBeLessThan(before - 100)
  expect(errors).toEqual([])
})

test("restoring an active process follows its current action after virtual body measurements", async () => {
  await page.goto(`${url}?scrolling`)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => {
    window.__conversationProcess.mode("full")
    window.__conversationProcess.restoreProcess(80)
  })
  const viewport = page.locator("[data-scroller]").last()
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
      const original = document.querySelector<HTMLElement>('[data-component="virtual-conversation-rows"]')!
      const height = original.querySelector<HTMLElement>(":scope > div")!.style.height
      const first = await new Promise<string>((resolve) => {
        const observer = new MutationObserver(() => {
          const current = document.querySelector<HTMLElement>('[data-component="virtual-conversation-rows"]')
          if (!current || current === original) return
          const content = current.querySelector<HTMLElement>(":scope > div")
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
    await page.goto(`${url}?scrolling`)
    await page.getByText("I will check the project first.", { exact: true }).waitFor()
    await page.evaluate(() => {
      window.__conversationProcess.mode("full")
      window.__conversationProcess.grow(40)
    })
    await settleConversation()
    const viewport = page.locator("[data-scroller]")
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
      const content = element.querySelector<HTMLElement>('[data-component="virtual-conversation-rows"]')!
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

test("a process locator opens a closed group and finds an offscreen Part in the conversation", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => {
    window.__conversationProcess.grow(1000)
    window.__conversationProcess.mode("minimal")
  })
  expect(await page.evaluate(() => window.__conversationProcess.locate("more", "many-400"))).toBe(true)
  await page.waitForFunction(() => {
    const part = document.querySelector('[data-part-id="many-400"]')
    const viewport = part?.closest("[data-scroller]")
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
    const viewport = page.locator("[data-scroller]").last()
    await viewport.evaluate((element) => {
      element.style.height = "16000px"
      element.style.maxHeight = "16000px"
      element.scrollTop = 0
    })
    await page.waitForFunction((owner) => {
      const viewport = document.querySelector("[data-scroller]")!
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

test("a located Part releases correction after reading restoration", async () => {
  await page.goto(`${url}?scrolling&outer-paging`)
  expect(await page.evaluate(() => window.__conversationProcess.locate("work", "reading-30"))).toBe(true)
  await page.locator("[data-scroller]").evaluate((element) => {
    element.dispatchEvent(new Event("conversation-reading-restored"))
    element.scrollTop = 0
  })
  await frames()
  await page.evaluate(() => window.__conversationProcess.hydrateBefore(80))
  await settleConversation()
  const visible = await page.locator('[data-part-id="reading-30"]').evaluateAll((parts) => {
    const bounds = document.querySelector("[data-scroller]")!.getBoundingClientRect()
    return parts.some((part) => {
      const row = part.getBoundingClientRect()
      return row.bottom > bounds.top && row.top < bounds.bottom
    })
  })
  expect(visible).toBe(false)
})
