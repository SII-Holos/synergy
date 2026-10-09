import { expect, test } from "bun:test"
import { page, url, errors, frames, contentPage, settleConversation } from "../../support/conversation-process"

test("grouped reasoning uses exact Part location and the main paragraph anchor during body growth", async () => {
  await page.goto(`${url}?scrolling`)
  await page.evaluate(() => window.__conversationProcess.fragments(80))
  const trigger = page.locator('[data-slot="process-reasoning-trigger"]').first()
  await trigger.waitFor()
  if ((await trigger.getAttribute("aria-expanded")) === "false") await trigger.click()
  expect(await page.evaluate(() => window.__conversationProcess.locate("work", "summary-14"))).toBe(true)
  await settleConversation()
  const fragment = page.locator('[data-reasoning-part="summary-14"]')
  const offset = () =>
    fragment.evaluate((element) => {
      const viewport = document.querySelector("[data-scroller]")!
      return element.getBoundingClientRect().top - viewport.getBoundingClientRect().top
    })
  expect(Math.abs(await offset())).toBeLessThanOrEqual(2)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 })
  try {
    await page.locator("[data-scroller]").hover()
    await page.mouse.wheel(0, 8)
    for (let index = 0; index < 6; index++) await frames()
    const before = await offset()
    await page.evaluate(() => {
      window.__conversationProcess.reasoning("Earlier reasoning grows. ".repeat(120), "summary-12")
      window.__conversationProcess.reasoning("Later reasoning grows. ".repeat(120), "summary-15")
    })
    for (let index = 0; index < 12; index++) {
      await frames()
      expect(Math.abs((await offset()) - before)).toBeLessThanOrEqual(2)
    }
    expect(await page.locator('[data-component="process-viewport"]').count()).toBe(0)
  } finally {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 })
    await cdp.detach()
  }
})

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

test("replayed additions and passive resize cannot follow a historical viewport", async () => {
  await page.goto(`${url}?scrolling`)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => {
    window.__conversationProcess.mode("full")
    window.__conversationProcess.grow(80)
  })
  const viewport = page.locator("[data-scroller]").last()
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
  await page.goto(`${url}?scrolling`)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => {
    window.__conversationProcess.grow(1000)
  })
  for (let index = 0; index < 4; index++) await frames()
  await page.waitForFunction(() => !document.querySelector("[data-motion-changing]"))
  const viewport = page.locator("[data-scroller]").last()
  await viewport.hover()
  await frames()
  const selected = await viewport.evaluate((element) => {
    const row = element.querySelector('[data-part-id="many-999"] [data-slot="activity-step-trigger"]')!
    const range = document.createRange()
    range.selectNodeContents(row)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event("selectionchange"))
    return selection.toString()
  })
  await frames()
  const before = await viewport.evaluate((element) => {
    const top = element.scrollTop
    const height = element.scrollHeight
    const row = [...element.querySelectorAll<HTMLElement>('[data-display-row][data-row-kind="body"]')].findLast(
      (row) => row.dataset.messageRole === "assistant",
    )!
    const probe = { row, calls: 0, connected: row.isConnected, height: row.getBoundingClientRect().height, grown: 0 }
    window.__processSelection = probe
    element.addEventListener(
      "wheel",
      () => {
        probe.calls++
        probe.connected = row.isConnected
        const body = document.createElement("p")
        body.textContent = "Late current-version output below the reading position. ".repeat(100)
        row.append(body)
        probe.grown = row.getBoundingClientRect().height
      },
      { once: true },
    )
    return { top, height }
  })
  await page.mouse.wheel(0, -120)
  for (let index = 0; index < 4; index++) await frames()
  const after = await viewport.evaluate((element) => {
    const probe = window.__processSelection as {
      row: HTMLElement
      calls: number
      connected: boolean
      height: number
      grown: number
    }
    return {
      top: element.scrollTop,
      height: element.scrollHeight,
      probe: {
        ...probe,
        row: probe.row.dataset.displayRow,
        stillConnected: probe.row.isConnected,
        measuredHeight: probe.row.getBoundingClientRect().height,
        wrapper: probe.row.parentElement?.getAttribute("style"),
      },
    }
  })
  expect(after.probe.calls).toBe(1)
  expect(after.probe.connected).toBe(true)
  expect(after.probe.stillConnected).toBe(true)
  expect(after.probe.measuredHeight).toBeGreaterThan(after.probe.height)
  expect(after.height).toBeGreaterThan(before.height)
  expect(after.top).toBeLessThanOrEqual(before.top - 100)
  expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(selected)
  expect(await page.locator('[data-slot="process-latest"]').count()).toBe(0)
})

test("native Space paging preserves new reading when real body growth follows its first movement", async () => {
  const cdp = await page.context().newCDPSession(page)
  try {
    await page.goto(`${url}?scrolling`)
    await page.getByText("I will check the project first.", { exact: true }).waitFor()
    await page.evaluate(() => window.__conversationProcess.grow(1000))
    expect(await page.evaluate(() => window.__conversationProcess.locate("more", "many-400"))).toBe(true)
    const viewport = page.locator("[data-scroller]").last()
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
    await part.locator('[data-slot="activity-step-trigger"]').evaluate((element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      document.getSelection()?.removeAllRanges()
      document.getSelection()?.addRange(range)
      document.dispatchEvent(new Event("selectionchange"))
    })
    await viewport.focus()
    for (let index = 0; index < 4; index++) await frames()
    expect(await viewport.evaluate((element) => document.activeElement === element)).toBe(true)
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 12 })
    const before = await viewport.evaluate((element) => {
      element.addEventListener("scroll", () => window.__conversationProcess.growToolEvidence("many-400"), {
        once: true,
      })
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

test("main reading survives live actions and return to latest resumes the conversation", async () => {
  await page.goto(`${url}?scrolling`)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => window.__conversationProcess.grow(80))
  expect(await page.evaluate(() => window.__conversationProcess.locate("more", "many-0"))).toBe(true)
  await settleConversation()
  const trigger = page.locator('[data-slot="activity-batch-trigger"]').last()
  await trigger.waitFor({ state: "visible" })
  await trigger.focus()
  expect(await trigger.evaluate((element) => document.activeElement === element)).toBe(true)
  if ((await trigger.getAttribute("aria-expanded")) === "true") {
    await trigger.click()
    await settleConversation()
    expect(await trigger.getAttribute("aria-expanded")).toBe("false")
  }
  await trigger.click()
  await settleConversation()
  expect(await trigger.getAttribute("aria-expanded")).toBe("true")
  const viewport = page.locator("[data-scroller]")
  await viewport.waitFor()
  await page.evaluate(() => window.__conversationProcess.latest())
  for (let index = 0; index < 15; index++) await frames()
  await page.evaluate(() => window.__conversationProcess.append("opened-live-action"))
  for (let index = 0; index < 15; index++) await frames()
  expect(
    await viewport.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop),
  ).toBeLessThanOrEqual(2)
  expect(await viewport.locator('[data-display-row][data-part-id="opened-live-action"]').count()).toBe(1)
  expect(await viewport.locator('[data-slot="activity-step"][data-part-id="opened-live-action"]').count()).toBe(1)
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
  expect(await viewport.locator('[data-display-row][data-part-id="reading-live-action"]').count()).toBe(1)
  expect(await viewport.locator('[data-slot="activity-step"][data-part-id="reading-live-action"]').count()).toBe(1)
  expect(errors).toEqual([])
})

test("SDK conflicts recover in real conversation rows across activity modes without altering literal message text", async () => {
  for (const mode of ["full", "balanced", "minimal"] as const) {
    await contentPage("conflict")
    await page
      .getByText("I will check the project first.", { exact: true })
      .waitFor()
      .catch(async (error) => {
        throw new Error(JSON.stringify({ url: page.url(), errors, html: await page.content() }), { cause: error })
      })
    await page.waitForFunction(() => window.__conversationProcess.contentReads("progress") === 2)
    await page.evaluate((mode) => window.__conversationProcess.mode(mode), mode)
    await frames()
    expect(await page.locator("[data-content-error]").count()).toBe(0)
    expect(await page.getByText("Literal message: [object Object]", { exact: true }).count()).toBe(1)
  }
  expect(errors).toEqual([])
}, 60000)

test("each part clears only its own failure and keeps the existing Markdown mounted", async () => {
  await contentPage("mixed")
  await page
    .getByText("Content unavailable: progress", { exact: true })
    .waitFor()
    .catch(async (error) => {
      throw new Error(JSON.stringify({ url: page.url(), errors, html: await page.content() }), { cause: error })
    })
  await page.evaluate(() => {
    window.answerNode = document.querySelector('[data-part-id="progress"] [data-component="markdown"]')
    window.__conversationProcess.contentRecover("progress")
  })
  await page.getByText("Content unavailable: progress-2", { exact: true }).waitFor()
  expect(await page.getByText("Content unavailable: progress", { exact: true }).count()).toBe(0)
  expect(
    await page.evaluate(
      () => window.answerNode === document.querySelector('[data-part-id="progress"] [data-component="markdown"]'),
    ),
  ).toBe(true)
  await page.evaluate(() => window.__conversationProcess.contentRecover("progress-2"))
  await page.waitForFunction(() => !document.querySelector("[data-content-error]"))
  expect(errors).toEqual([])
}, 60000)

test("manual retry is keyboard accessible, disables duplicate requests and clears the recovered error", async () => {
  await contentPage("mixed")
  await page.getByText("Content unavailable: progress", { exact: true }).waitFor()
  await page.evaluate(() => {
    window.__conversationProcess.contentRecover("progress-2")
    window.__conversationProcess.contentPending("progress")
  })
  const retry = page.getByRole("button", { name: "Retry loading content", exact: true })
  await retry.focus()
  await page.evaluate(() => {
    window.answerNode = document.activeElement?.closest("[data-display-row]")
  })
  await retry.press("Enter")
  const pending = page.getByRole("button", { name: "Retrying…", exact: true })
  await pending.waitFor()
  expect(await pending.isDisabled()).toBe(true)
  await pending.evaluate((button) => (button as HTMLButtonElement).click())
  expect(await page.evaluate(() => window.__conversationProcess.contentReads("progress"))).toBe(2)
  await page.evaluate(() => window.__conversationProcess.contentFinish("progress"))
  await page.waitForFunction(() => !document.querySelector("[data-content-error]"))
  expect(await page.evaluate(() => document.activeElement === window.answerNode)).toBe(true)
  await contentPage("mixed")
  await page.getByText("Content unavailable: progress", { exact: true }).waitFor()
  await page.evaluate(() => {
    window.__conversationProcess.contentRecover("progress-2")
    window.__conversationProcess.contentPending("progress")
  })
  await page.getByRole("button", { name: "Retry loading content", exact: true }).press("Enter")
  await page.getByRole("button", { name: "Retrying…", exact: true }).waitFor()
  await page.getByRole("button", { name: "Outside conversation", exact: true }).focus()
  await page.evaluate(() => window.__conversationProcess.contentFinish("progress"))
  await page.waitForFunction(() => !document.querySelector("[data-content-error]"))
  expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-outside-control"))).toBe(true)
  expect(errors).toEqual([])
}, 60000)

test("exhausted conflicts show a sync retry and malformed errors use a readable fallback", async () => {
  await contentPage("stalled")
  await page.getByText("Couldn’t sync this content", { exact: true }).waitFor()
  expect(await page.evaluate(() => window.__conversationProcess.contentReads("progress"))).toBe(8)
  await frames()
  expect(await page.evaluate(() => window.__conversationProcess.contentReads("progress"))).toBe(8)
  await contentPage("malformed")
  await page.getByText("Couldn’t load this content", { exact: true }).waitFor()
  expect(await page.locator("[data-content-error]").innerText()).not.toContain("[object Object]")
  expect(await page.getByRole("button", { name: "Retry loading content", exact: true }).count()).toBe(1)
  expect(errors).toEqual([])
}, 60000)

test("stale accepted summaries revalidate without removing current content or replaying its entrance", async () => {
  await page.goto(url)
  const prose = page.getByText("I will check the project first.", { exact: true })
  await prose.waitFor()
  await page.evaluate(() => {
    window.answerNode = document.querySelector('[data-part-id="progress"] [data-component="markdown"]')
    window.__conversationProcess.contentStale()
  })
  await frames()
  expect(await page.evaluate(() => window.__conversationProcess.contentPageLoads())).toBeGreaterThan(0)
  expect(await page.evaluate(() => !!window.answerNode?.isConnected)).toBe(true)
  expect(await prose.count()).toBe(1)
  await page.evaluate(() => window.__conversationProcess.contentPageFinish())
  await frames()
  expect(
    await page.evaluate(
      () => window.answerNode === document.querySelector('[data-part-id="progress"] [data-component="markdown"]'),
    ),
  ).toBe(true)
  expect(await prose.count()).toBe(1)
  expect(await page.locator('[data-part-id="progress"] [data-motion-changing]').count()).toBe(0)
})

test("same-version summary refresh preserves a healthy pending body read", async () => {
  await contentPage("pending-refresh")
  const prose = page.getByText("I will check the project first.", { exact: true })
  await page.waitForFunction(() => window.__conversationProcess.contentReads("progress") === 1)
  expect(await prose.count()).toBe(0)
  await page.evaluate(() => window.__conversationProcess.contentStale())
  await page.waitForFunction(() => window.__conversationProcess.contentPageLoads() > 0)
  await page.evaluate(() => window.__conversationProcess.contentPageFinish())
  await frames()
  expect(await page.evaluate(() => window.__conversationProcess.contentReads("progress"))).toBe(1)
  expect(await page.evaluate(() => window.__conversationProcess.contentAborts("progress"))).toBe(0)
  await page.evaluate(() => window.__conversationProcess.contentFinish("progress"))
  await prose.waitFor()
  expect(await page.evaluate(() => window.__conversationProcess.contentReads("progress"))).toBe(1)
  expect(await page.locator("[data-content-error]").count()).toBe(0)
  expect(errors).toEqual([])
}, 30000)

test("reconnect renews invalidated body leases even when the summary version stays the same", async () => {
  await contentPage("conflict")
  await page.waitForFunction(() => window.__conversationProcess.contentReads("progress") === 2)
  await page.evaluate(() => window.__conversationProcess.contentReconnect())
  await page.waitForFunction(() => window.__conversationProcess.contentReads("progress") === 3)
  expect(await page.locator("[data-content-error]").count()).toBe(0)
  expect(errors).toEqual([])
}, 30000)

test("reconnect before the first summary page finishes restores invalidated bodies", async () => {
  await contentPage("late-reconnect")
  const prose = page.getByText("I will check the project first.", { exact: true })
  await prose.waitFor()
  await page.waitForFunction(() => window.__conversationProcess.contentReads("progress") > 0)
  const reads = await page.evaluate(() => window.__conversationProcess.contentReads("progress"))
  await page.evaluate(() => window.__conversationProcess.contentReconnect())
  await prose.waitFor({ state: "hidden" })
  await page.evaluate(() => window.__conversationProcess.contentPageFinish())
  await prose.waitFor()
  expect(await page.evaluate(() => window.__conversationProcess.contentReads("progress"))).toBeGreaterThan(reads)
  expect(await page.locator("[data-content-error]").count()).toBe(0)
  expect(errors).toEqual([])
}, 30000)
