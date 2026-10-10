import { expect, test } from "bun:test"
import { page, url, errors, frames } from "../../support/conversation-process"

test("reading a grouped reasoning fragment survives an earlier fragment growing in the same virtual chunk", async () => {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 })
  try {
    await page.goto(url)
    await page.evaluate(() => window.__conversationProcess.fragments(12))
    const trigger = page.locator('[data-slot="process-reasoning-trigger"]')
    await trigger.waitFor()
    if ((await trigger.getAttribute("aria-expanded")) === "false") await trigger.click()
    await page.getByText("Summary paragraph 7", { exact: true }).waitFor()
    await page.waitForFunction(() => !document.querySelector("[data-motion-changing]"))
    const viewport = page.locator('[data-component="process-viewport"]').first()
    await viewport.evaluate((element) => ((element as HTMLElement).style.maxHeight = "140px"))
    await viewport.hover()
    await page.mouse.wheel(0, -1)
    await frames()
    await viewport.evaluate((element) => {
      const target = element.querySelector<HTMLElement>('[data-reasoning-part="summary-7"]')!
      element.scrollTop += target.getBoundingClientRect().top - element.getBoundingClientRect().top - 2
    })
    await frames()
    const position = () =>
      viewport.evaluate((element) => {
        const target = element.querySelector<HTMLElement>('[data-reasoning-part="summary-7"]')!
        return target.getBoundingClientRect().top - element.getBoundingClientRect().top
      })
    const before = await position()
    expect(Math.abs(before - 2)).toBeLessThanOrEqual(1)
    await page.evaluate(() =>
      window.__conversationProcess.reasoning("An earlier fragment finishes loading.\n".repeat(12), "summary-6"),
    )
    await frames()
    expect(Math.abs((await position()) - before)).toBeLessThanOrEqual(1)
    await page.evaluate(() =>
      window.__conversationProcess.reasoning("A later fragment finishes loading.\n".repeat(12), "summary-10"),
    )
    await frames()
    expect(Math.abs((await position()) - before)).toBeLessThanOrEqual(1)
  } finally {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 })
    await cdp.detach()
  }
}, 30000)

test("a history locator retains its Part through late preceding summaries and releases on wheel input", async () => {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 })
  try {
    await page.goto(url)
    await page.getByText("I will check the project first.", { exact: true }).waitFor()
    await page.evaluate(() => {
      window.__conversationProcess.stream()
      window.__conversationProcess.complete()
    })
    expect(await page.evaluate(() => window.__conversationProcess.locate("final", "answer"))).toBe(true)
    await page.evaluate(() => window.__conversationProcess.hydrateBefore(60))
    await page.waitForFunction(() => {
      const part = document.querySelector('[data-part-id="answer"]')
      const bounds = document.querySelector("[data-scroller]")!.getBoundingClientRect()
      const item = part?.getBoundingClientRect()
      return item && item.bottom > bounds.top && item.top < bounds.bottom
    })
    await page.getByText("Final answer stays mounted.", { exact: true }).hover()
    await page.mouse.wheel(0, -1000)
    await page.waitForFunction(() => {
      const part = document.querySelector('[data-part-id="answer"]')
      const bounds = document.querySelector("[data-scroller]")!.getBoundingClientRect()
      const item = part?.getBoundingClientRect()
      return !item || item.top >= bounds.bottom || item.bottom <= bounds.top
    })
    expect(await page.locator("[data-display-row]").count()).toBeLessThan(80)
    expect(await page.evaluate(() => window.__conversationProcess.locate("final", "answer"))).toBe(true)
    await page.evaluate(() => window.__conversationProcess.prepare())
    await frames()
    await page.evaluate(() => {
      document.querySelector("[data-scroller]")!.scrollTop = 0
      window.__conversationProcess.stream()
      window.__conversationProcess.complete()
    })
    await frames()
    await page.getByText("Final answer stays mounted.", { exact: true }).waitFor({ state: "detached" })
    expect(errors).toEqual([])
  } finally {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 })
    await cdp.detach()
  }
})

test("an unfocused process reader survives outer layout changes until an outer reading gesture", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => window.__conversationProcess.mode("full"))
  const viewport = page.locator('[data-component="process-viewport"]').first()
  const trigger = viewport.locator('[data-slot="process-reasoning-trigger"]')
  if ((await trigger.getAttribute("aria-expanded")) === "true")
    await trigger.evaluate((button) => (button as HTMLElement).click())
  await trigger.evaluate((button) => (button as HTMLElement).click())
  await page.getByText("Check evidence", { exact: true }).waitFor()
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    window.__conversationProcess.hydrateBefore(80)
  })
  await page.locator("[data-scroller]").evaluate((scroller) => (scroller.scrollTop = 0))
  await frames()
  await frames()
  expect(await viewport.count()).toBeGreaterThan(0)
  expect(await page.getByText("Check evidence", { exact: true }).count()).toBe(1)
  await page
    .locator("[data-outside-control]")
    .evaluate((control) => control.dispatchEvent(new WheelEvent("wheel", { deltaY: 1, bubbles: true })))
  await page.waitForFunction(() => !document.querySelector('[data-component="process-viewport"]'))
})

test("an already-paused process reader reacquires retention after another reader takes ownership", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => window.__conversationProcess.mode("full"))
  await page.waitForFunction(() => document.querySelectorAll('[data-component="process-viewport"]').length === 2)
  await page.evaluate(() => {
    const [first, second] = document.querySelectorAll('[data-component="process-viewport"]')
    for (const viewport of [first, second, first])
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }))
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    window.__conversationProcess.hydrateBefore(80)
  })
  await page.locator("[data-scroller]").evaluate((scroller) => (scroller.scrollTop = 0))
  await frames()
  await frames()
  await page.waitForFunction(() => document.querySelectorAll('[data-component="process-viewport"]').length === 1)
  expect(await page.locator('[data-component="process-viewport"]').textContent()).toContain("Check evidence")
  expect(await page.getByText("Continue checking", { exact: true }).count()).toBe(0)
})

test("replayed additions and passive resize cannot follow a historical viewport", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => {
    window.__conversationProcess.mode("full")
    window.__conversationProcess.grow(80)
  })
  const viewport = page.locator('[data-component="process-viewport"]').last()
  await page.waitForTimeout(250)
  await viewport.evaluate((el) => {
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -24, bubbles: true }))
    el.scrollTop = 40
    ;(el as HTMLElement).style.maxHeight = "200px"
  })
  await frames()
  const before = await viewport.evaluate((el) => el.scrollTop)
  await page.evaluate(() => {
    window.__conversationProcess.append("late-history", "replay")
    ;(document.querySelector("[data-scroller]") as HTMLElement).style.height = "580px"
  })
  await frames()
  expect(await viewport.evaluate((el) => el.scrollTop)).toBe(before)
})

test("loading earlier turns from latest preserves the visible outer row before and after measurement", async () => {
  await page.goto(`${url}?scrolling=1`)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.locator("[data-scroller]").evaluate((element) => {
    element.style.height = "280px"
  })
  for (let index = 0; index < 4; index++) await frames()
  const before = await page.locator("[data-scroller]").evaluate((element) => {
    element.scrollTop = element.scrollHeight
    const bounds = element.getBoundingClientRect()
    const row = [...element.querySelectorAll<HTMLElement>("[data-display-row]")].find((row) => {
      const rect = row.getBoundingClientRect()
      return (
        !row.closest('[data-component="process-viewport"]') &&
        rect.height > 0 &&
        rect.bottom > bounds.top &&
        rect.top < bounds.bottom
      )
    })!
    return {
      top: element.scrollTop,
      key: row.dataset.displayRow!,
      offset: row.getBoundingClientRect().top - bounds.top,
    }
  })
  await frames()
  expect(before.top).toBeGreaterThan(0)
  await page.evaluate(() => window.__conversationProcess.prependTurns(120))
  for (let index = 0; index < 8; index++) await frames()
  const after = await page.locator("[data-scroller]").evaluate((element, key) => {
    const row = [...element.querySelectorAll<HTMLElement>("[data-display-row]")].find(
      (row) => row.dataset.displayRow === key,
    )
    return {
      top: element.scrollTop,
      offset: row ? row.getBoundingClientRect().top - element.getBoundingClientRect().top : undefined,
    }
  }, before.key)
  expect(after.offset).toBeDefined()
  expect(Math.abs(after.offset! - before.offset)).toBeLessThanOrEqual(2)
  expect(after.top).toBeGreaterThan(before.top)
})

test.each(["system-ui", "sans-serif"])(
  "historical Part backfill preserves latest reading when retained rows move inside the same root (%s)",
  async (font) => {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 })
    try {
      await page.goto(`${url}?scrolling=1`)
      await page.getByText("I will check the project first.", { exact: true }).waitFor()
      await page.addStyleTag({ content: `#root, #root * { font-family: ${font} !important }` })
      await page.locator("[data-scroller]").evaluate((element) => {
        element.style.height = "280px"
      })
      for (let index = 0; index < 4; index++) await frames()
      const before = await page.locator("[data-scroller]").evaluate((element) => {
        element.scrollTop = element.scrollHeight
        const row = element.querySelector<HTMLElement>('[data-display-row="root:process"]')!
        return { offset: row.getBoundingClientRect().top - element.getBoundingClientRect().top, top: element.scrollTop }
      })
      await frames()
      await page.evaluate(() => window.__conversationProcess.backfill(60))
      for (let index = 0; index < 8; index++) await frames()
      const after = await page.locator("[data-scroller]").evaluate((element) => {
        const row = element.querySelector<HTMLElement>('[data-display-row="root:process"]')
        return {
          offset: row ? row.getBoundingClientRect().top - element.getBoundingClientRect().top : undefined,
          top: element.scrollTop,
        }
      })
      expect(after.offset).toBeDefined()
      expect(Math.abs(after.offset! - before.offset)).toBeLessThanOrEqual(2)
      expect(after.top).toBeGreaterThan(before.top)
    } finally {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 })
      await cdp.detach()
    }
  },
)
for (const { key, change } of [
  ...["Space", "Shift+Space", "PageDown", "PageUp"].map((key) => ({ key, change: "internal Part backfill" })),
  { key: "Space", change: "same-version body growth" },
])
  test(`outer ${key} paging keeps the new reading row through ${change}`, async () => {
    await page.goto(`${url}?scrolling=1&outer-paging=1`)
    const scroll = page.locator("[data-scroller]")
    await scroll.evaluate((element) => {
      element.style.height = "280px"
    })
    expect(await page.evaluate(() => window.__conversationProcess.locate("work", "reading-30"))).toBe(true)
    const reference = page.getByRole("link", { name: "Project reference 30", exact: true })
    await reference.focus()
    const selected =
      change === "same-version body growth"
        ? await reference.evaluate((element) => {
            const range = document.createRange()
            range.selectNodeContents(element)
            const selection = document.getSelection()!
            selection.removeAllRanges()
            selection.addRange(range)
            return selection.toString()
          })
        : undefined
    const bounds = await scroll.boundingBox()
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2)
    await page.mouse.wheel(0, -600)
    for (let index = 0; index < 6; index++) await frames()
    expect(await reference.evaluate((element) => element === document.activeElement)).toBe(true)
    const visible = () =>
      scroll.evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        const row = [...element.querySelectorAll<HTMLElement>("[data-display-row]")].find((row) => {
          const rect = row.getBoundingClientRect()
          return (
            !row.closest('[data-component="process-viewport"]') &&
            rect.height > 0 &&
            rect.bottom > bounds.top &&
            rect.top < bounds.bottom
          )
        })!
        return {
          top: element.scrollTop,
          key: row.dataset.displayRow!,
          offset: row.getBoundingClientRect().top - bounds.top,
          focused: document.activeElement?.closest<HTMLElement>("[data-display-row]")?.dataset.displayRow,
        }
      })
    const previous = await visible()
    await page.keyboard.press(key)
    for (let index = 0; index < 12; index++) await frames()
    const before = await visible()
    expect(await reference.evaluate((element) => element === document.activeElement)).toBe(true)
    if (selected) expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(selected)
    expect(Math.abs(before.top - previous.top)).toBeGreaterThan(100)
    expect(before.key).not.toBe(previous.key)
    expect(before.key).not.toBe(before.focused)
    const height = await scroll.evaluate((element) => element.scrollHeight)
    if (change === "internal Part backfill") await page.evaluate(() => window.__conversationProcess.backfill(120))
    else {
      await page.evaluate(
        (id) => window.__conversationProcess.growReadingParagraph(id, 600),
        before.key.replace(/^work:/, ""),
      )
    }
    for (let index = 0; index < 8; index++) await frames()
    if (change === "same-version body growth")
      expect(await scroll.evaluate((element) => element.scrollHeight)).toBeGreaterThan(height + 500)
    const after = await scroll.evaluate((element, key) => {
      const row = [...element.querySelectorAll<HTMLElement>("[data-display-row]")].find(
        (row) => row.dataset.displayRow === key,
      )
      return {
        connected: !!row?.isConnected,
        offset: row ? row.getBoundingClientRect().top - element.getBoundingClientRect().top : undefined,
      }
    }, before.key)
    expect(after.connected).toBe(true)
    expect(Math.abs(after.offset! - before.offset)).toBeLessThanOrEqual(2)
    if (selected) expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(selected)
  })

test("native Shift+Space leaves latest following and retains its reading row through background backfill", async () => {
  await page.goto(`${url}?scrolling=1&outer-paging=1`)
  const scroll = page.locator("[data-scroller]")
  await scroll.evaluate((element) => {
    element.style.height = "280px"
  })
  expect(await page.evaluate(() => window.__conversationProcess.locate("work", "reading-59"))).toBe(true)
  const link = page.getByRole("link", { name: "Project reference 59", exact: true })
  await link.waitFor({ state: "visible" })
  await link.evaluate((element) => (element as HTMLElement).focus({ preventScroll: true }))
  // The setup locator retains its own anchor until input; release it before testing Latest following.
  await link.press("Escape")
  await page.evaluate(() => window.__conversationProcess.latest())
  for (let index = 0; index < 4; index++) await frames()
  await page.waitForFunction(() => {
    const scroll = document.querySelector<HTMLElement>("[data-scroller]")!
    return Math.abs(scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop) <= 2
  })
  expect(
    await page
      .getByRole("link", { name: "Project reference 59", exact: true })
      .evaluate((element) => document.activeElement === element),
  ).toBe(true)
  const latest = await scroll.evaluate((element) => element.scrollTop)
  await page.keyboard.press("Shift+Space")
  for (let index = 0; index < 12; index++) await frames()
  const before = await scroll.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    const row = [...element.querySelectorAll<HTMLElement>("[data-display-row]")].find((row) => {
      const rect = row.getBoundingClientRect()
      return (
        !row.closest('[data-component="process-viewport"]') &&
        rect.height > 0 &&
        rect.bottom > bounds.top &&
        rect.top < bounds.bottom
      )
    })!
    return {
      key: row.dataset.displayRow!,
      top: element.scrollTop,
      offset: row.getBoundingClientRect().top - bounds.top,
    }
  })
  expect(latest - before.top).toBeGreaterThan(100)
  await page.evaluate(() => window.__conversationProcess.hydrateBefore(120))
  for (let index = 0; index < 8; index++) await frames()
  const after = await scroll.evaluate((element, key) => {
    const row = [...element.querySelectorAll<HTMLElement>("[data-display-row]")].find(
      (row) => row.dataset.displayRow === key,
    )
    return {
      connected: !!row?.isConnected,
      offset: row ? row.getBoundingClientRect().top - element.getBoundingClientRect().top : undefined,
    }
  }, before.key)
  expect(after.connected).toBe(true)
  expect(Math.abs(after.offset! - before.offset)).toBeLessThanOrEqual(2)
})

test("native reading movement wins over real body growth in the same wheel dispatch", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => {
    window.__conversationProcess.grow(1000)
  })
  for (let index = 0; index < 4; index++) await frames()
  await page.waitForFunction(() => !document.querySelector("[data-motion-changing]"))
  const viewport = page.locator('[data-component="process-viewport"]').last()
  await viewport.hover()
  await frames()
  const before = await viewport.evaluate((element) => {
    const top = element.scrollTop
    const height = element.scrollHeight
    element.addEventListener(
      "wheel",
      () => {
        const body = document.createElement("p")
        body.textContent = "Late current-version output below the reading position. ".repeat(100)
        ;[...element.querySelectorAll("[data-display-row]")].at(-1)!.append(body)
      },
      { once: true },
    )
    return { top, height }
  })
  await page.mouse.wheel(0, -120)
  for (let index = 0; index < 4; index++) await frames()
  const after = await viewport.evaluate((element) => ({ top: element.scrollTop, height: element.scrollHeight }))
  expect(after.height).toBeGreaterThan(before.height)
  expect(after.top).toBeLessThanOrEqual(before.top - 100)
  expect(await page.locator('[data-slot="process-latest"]').count()).toBe(0)
})

test("native Space paging preserves new reading when real body growth follows its first movement", async () => {
  const cdp = await page.context().newCDPSession(page)
  try {
    await page.goto(url)
    await page.getByText("I will check the project first.", { exact: true }).waitFor()
    await page.evaluate(() => window.__conversationProcess.grow(1000))
    expect(await page.evaluate(() => window.__conversationProcess.locate("more", "many-400"))).toBe(true)
    const viewport = page.locator('[data-component="process-viewport"]').last()
    const part = viewport.locator('[data-slot="activity-step"][data-part-id="many-400"]')
    await part.waitFor()
    await viewport.evaluate(async (element) => {
      await Promise.allSettled(
        element
          .getAnimations({ subtree: true })
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished),
      )
      const part = element.querySelector<HTMLElement>('[data-part-id="many-400"]')!
      element.scrollTop += part.getBoundingClientRect().top - element.getBoundingClientRect().top
    })
    await viewport.focus()
    for (let index = 0; index < 4; index++) await frames()
    expect(await viewport.evaluate((element) => document.activeElement === element)).toBe(true)
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 12 })
    const before = await viewport.evaluate((element) => {
      element.addEventListener(
        "keydown",
        () => {
          element.addEventListener("scroll", () => window.__conversationProcess.growToolEvidence("many-400"), {
            once: true,
          })
        },
        { once: true },
      )
      return {
        top: element.scrollTop,
        height: element.scrollHeight,
        remaining: element.scrollHeight - element.clientHeight - element.scrollTop,
      }
    })
    expect(before.remaining).toBeGreaterThan(1000)
    await viewport.press("Space")
    for (let index = 0; index < 12; index++) await frames()
    const after = await viewport.evaluate((element) => ({ top: element.scrollTop, height: element.scrollHeight }))
    expect(await viewport.locator('[data-part-id="many-400"] [data-slot="activity-evidence"]').count()).toBe(1)
    expect(after.height).toBeGreaterThan(before.height)
    expect(after.top).toBeGreaterThan(before.top + 100)
  } finally {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 })
    await cdp.detach()
  }
})

test("local reading survives new actions, history prepend and reopening without moving the outer stream", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => window.__conversationProcess.grow(1000))
  expect(await page.evaluate(() => window.__conversationProcess.locate("more", "many-400"))).toBe(true)
  const viewport = page.locator('[data-component="process-viewport"]').last()
  const part = page.locator('[data-slot="activity-step"][data-part-id="many-400"]')
  await part.waitFor()
  await viewport.evaluate(async (element) => {
    await Promise.allSettled(
      element
        .getAnimations({ subtree: true })
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished),
    )
  })
  await viewport.focus()
  await viewport.press("ArrowUp")
  await viewport.evaluate(async (element) => {
    let previous = element.scrollTop,
      stable = 0
    for (let i = 0; i < 40 && stable < 4; i++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      const next = element.scrollTop
      stable = next === previous ? stable + 1 : 0
      previous = next
    }
  })
  await frames()
  const before = await part.evaluate((el) => el.getBoundingClientRect().top)
  const outer = await page.locator("[data-scroller]").evaluate((el) => el.scrollTop)
  await page.evaluate(() => window.__conversationProcess.append("live-reading-append"))
  await frames()
  await frames()
  expect(Math.abs((await part.evaluate((el) => el.getBoundingClientRect().top)) - before)).toBeLessThan(2)
  expect(await page.locator("[data-scroller]").evaluate((el) => el.scrollTop)).toBe(outer)
  await page.evaluate(() => window.__conversationProcess.prepend(24))
  await frames()
  expect(Math.abs((await part.evaluate((el) => el.getBoundingClientRect().top)) - before)).toBeLessThan(2)
  expect(await page.locator("[data-scroller]").evaluate((el) => el.scrollTop)).toBe(outer)
  expect(await page.locator('[data-slot="process-latest"]').count()).toBe(0)
  const header = page.locator('[data-slot="turn-process-trigger"]')
  const relative = await part.evaluate(
    (el) =>
      el.getBoundingClientRect().top - el.closest('[data-component="process-viewport"]')!.getBoundingClientRect().top,
  )
  await header.click()
  await page.waitForFunction(() => !document.querySelector('[data-row-kind="activity"]'))
  await header.click()
  await frames()
  await frames()
  await page.locator("[data-scroller]").evaluate((element, offset) => (element.scrollTop = offset), outer)
  await frames()
  expect(
    Math.abs(
      (await part.evaluate(
        (el) =>
          el.getBoundingClientRect().top -
          el.closest('[data-component="process-viewport"]')!.getBoundingClientRect().top,
      )) - relative,
    ),
  ).toBeLessThan(2)
  expect(await page.evaluate(() => window.__conversationProcess.retained())).toBeLessThan(120)
  await viewport.focus()
  await viewport.press("End")
  await page.waitForFunction(() => {
    const part = document.querySelector('[data-part-id="live-reading-append"]')
    const viewport = part?.closest('[data-component="process-viewport"]')
    if (!part || !viewport) return false
    const bounds = viewport.getBoundingClientRect(),
      row = part.getBoundingClientRect()
    return row.height > 0 && row.bottom > bounds.top && row.top < bounds.bottom
  })
}, 30000)

test("opening a live group follows its actions independently and the outer latest action resumes it", async () => {
  await page.goto(`${url}?scrolling`)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => window.__conversationProcess.grow(80))
  const trigger = page.locator('[data-slot="activity-batch-trigger"]').last()
  if ((await trigger.getAttribute("aria-expanded")) === "true") await trigger.click()
  await trigger.click()
  const viewport = page.locator('[data-component="process-viewport"]').last()
  await viewport.waitFor()
  for (let index = 0; index < 15; index++) await frames()
  const outer = page.locator("[data-scroller]")
  const outerTop = await outer.evaluate((element) => element.scrollTop)
  await page.evaluate(() => window.__conversationProcess.append("opened-live-action"))
  for (let index = 0; index < 15; index++) await frames()
  expect(
    await viewport.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop),
  ).toBeLessThanOrEqual(2)
  expect(await viewport.locator('[data-part-id="opened-live-action"]').count()).toBe(1)
  expect(await outer.evaluate((element) => element.scrollTop)).toBe(outerTop)
  await viewport.hover()
  await page.mouse.wheel(0, -120)
  for (let index = 0; index < 10; index++) await frames()
  const reading = await viewport.evaluate((element) => element.scrollTop)
  await page.evaluate(() => window.__conversationProcess.append("reading-live-action"))
  for (let index = 0; index < 15; index++) await frames()
  expect(await viewport.evaluate((element) => element.scrollTop)).toBe(reading)
  expect(await page.locator('[data-slot="process-latest"]').count()).toBe(0)
  await page.evaluate(() => window.__conversationProcess.latest())
  for (let index = 0; index < 15; index++) await frames()
  expect(
    await viewport.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop),
  ).toBeLessThanOrEqual(2)
  expect(await viewport.locator('[data-part-id="reading-live-action"]').count()).toBe(1)
  expect(errors).toEqual([])
})
