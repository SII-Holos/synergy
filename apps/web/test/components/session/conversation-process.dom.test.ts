import { expect, test } from "bun:test"
import { browser, page, url, errors, frames, contentPage } from "../../support/conversation-process"

test("compact activity titles retain successful facts while showing current runtime activity", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  const titles = page.locator('[data-component="conversation-activity"] > [data-slot="activity-batch-trigger"]')
  const latest = titles.last()
  const status = latest.locator('[data-slot="activity-batch-status"]')
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
  await frames()
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-slot="activity-batch-status"]')].some((node) =>
      node.textContent?.includes("Calling tool"),
    ),
  )
  expect(await status.textContent()).toContain("Calling tool")
  expect(await page.evaluate(() => window.__activityTitle?.firstElementChild === window.__activityFacts)).toBe(true)
  const animation = () =>
    status.locator('[data-slot="activity-batch-status-text"]').evaluate((el) => getComputedStyle(el).animationName)
  expect(await animation()).not.toBe("none")
  await page.evaluate(() => window.__conversationProcess.approval(true))
  await frames()
  expect(await status.textContent()).toContain("Waiting for your approval")
  expect(await animation()).toBe("none")
  await page.evaluate(() => {
    window.__conversationProcess.approval(false)
    window.__conversationProcess.connected(false)
  })
  await frames()
  expect(await status.textContent()).toContain("Reconnecting")
  expect(await animation()).toBe("none")
  await page.evaluate(() => {
    window.__conversationProcess.connected(true)
    window.__conversationProcess.phase({ phase: "stopping", startedAt: 3, rootID: "root" })
  })
  await frames()
  expect(await status.textContent()).toContain("Stopping")
  expect(await animation()).toBe("none")
  await page.evaluate(() =>
    window.__conversationProcess.phase({ phase: "waiting_model", startedAt: 4, rootID: "root" }),
  )
  await page.emulateMedia({ reducedMotion: "reduce" })
  expect(await animation()).toBe("none")
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-slot="activity-batch-status"]')].some((node) =>
      node.textContent?.includes("Waiting for model response"),
    ),
  )
  expect(await status.textContent()).toContain("Waiting for model response")
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.evaluate(() => {
    window.__conversationProcess.stream()
    window.__conversationProcess.complete()
  })
  await frames()
  expect(await page.locator('[data-slot="activity-batch-status"]').count()).toBe(0)
})

test("compact activity titles reveal secondary arrows without moving their labels", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  const title = page.locator('[data-component="conversation-activity"] > button').last()
  const arrow = title.locator('[data-component="icon"]').last()
  await page.mouse.move(0, 0)
  expect(await arrow.evaluate((el) => getComputedStyle(el).opacity)).toBe("0")
  await title.scrollIntoViewIfNeeded()
  const bounds = await title.boundingBox()
  await title.hover()
  await page.waitForFunction(() => {
    const title = [...document.querySelectorAll('[data-component="conversation-activity"] > button')].at(-1)!
    return getComputedStyle(title.querySelector('[data-component="icon"]')!).opacity === "1"
  })
  expect(await title.boundingBox()).toEqual(bounds)
  await page.mouse.move(0, 0)
  await title.focus()
  await title.press("Space")
  expect(await title.getAttribute("aria-expanded")).toBe("false")
  expect(await arrow.evaluate((el) => getComputedStyle(el).opacity)).toBe("1")
  await title.press("Enter")
  expect(await title.getAttribute("aria-expanded")).toBe("true")
  const touch = await browser.newPage({ hasTouch: true, viewport: { width: 375, height: 812 } })
  try {
    await touch.goto(url)
    await touch.getByText("I will check the project first.", { exact: true }).waitFor()
    const title = touch.locator('[data-component="conversation-activity"] > button').last()
    expect(
      await title
        .locator('[data-component="icon"]')
        .last()
        .evaluate((el) => getComputedStyle(el).opacity),
    ).toBe("1")
    expect((await title.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  } finally {
    await touch.close()
  }
})

test("compact conversation flow keeps prose and folded summaries at an even visual distance", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => {
    window.__conversationProcess.stream()
    window.__conversationProcess.mode("full")
  })
  await frames()
  for (const title of await page.locator('[data-component="conversation-activity"] > button').all()) {
    if ((await title.getAttribute("aria-expanded")) === "true") await title.click()
  }
  await page.waitForFunction(() => !document.querySelector("[data-motion-changing]"))
  await frames()
  const gaps = await page.evaluate(() => {
    const prose = document
      .querySelector('[data-part-id="progress"] [data-component="text-part"]')!
      .getBoundingClientRect()
    const summary = [...document.querySelectorAll('[data-component="conversation-activity"] > button')]
      .at(-1)!
      .getBoundingClientRect()
    const answer = document
      .querySelector('[data-part-id="answer"] [data-component="text-part"]')!
      .getBoundingClientRect()
    return [summary.top - prose.bottom, answer.top - summary.bottom]
  })
  expect(Math.max(...gaps)).toBeLessThanOrEqual(10)
  expect(Math.min(...gaps)).toBeGreaterThanOrEqual(4)
  expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(2)
})

test("a late child delivery has one chronological process row and opens the right inspector", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => window.__conversationProcess.delivery())
  const delivery = page.locator('[data-component="process-event-row"]')
  await delivery.waitFor()
  expect(await delivery.count()).toBe(1)
  expect(await page.locator('[data-row-kind="process"] [data-component="process-event-row"]').count()).toBe(0)
  expect(await page.locator('[data-row-kind="footer"] [data-component="process-event-row"]').count()).toBe(0)
  expect(await delivery.locator("button").textContent()).toContain("Check browser readiness")
  await delivery.locator("button").click()
  expect(await page.evaluate(() => window.__processSelection)).toEqual({
    kind: "agent-delivery",
    sessionID: "session",
    messageID: "delivery",
  })
  expect(await page.getByText("Captured child result", { exact: true }).count()).toBe(0)
})

test("cold user attachments keep their folded geometry outside process preparation", async () => {
  await contentPage("cold-user")
  const user = page.locator('[data-display-row][data-row-kind="body"][data-message-role="user"]')
  await user.waitFor()
  expect(await user.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(500)
  await page.evaluate(() => {
    for (let index = 0; index < 32; index++) window.__conversationProcess.contentFinish(`file-${index}`)
  })
  await page.getByText("Document 0.txt", { exact: true }).waitFor()
  await frames()
  expect(await user.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(500)
  expect(await page.getByText("Final answer stays mounted.", { exact: true }).count()).toBe(1)
})

test("reasoning chevrons appear on hover and focus and remain visible on touch", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => window.__conversationProcess.mode("full"))
  const trigger = page.locator('[data-slot="process-reasoning-trigger"]').first()
  await trigger.waitFor()
  const arrow = trigger.locator('[data-component="icon"]').last()
  await page.mouse.move(0, 0)
  expect(await arrow.evaluate((element) => getComputedStyle(element).opacity)).toBe("0")
  await trigger.hover()
  await page.waitForFunction(() => {
    const trigger = document.querySelector('[data-slot="process-reasoning-trigger"]:hover')!
    return getComputedStyle(trigger.querySelector('[data-component="icon"]:last-child')!).opacity === "1"
  })
  expect(await arrow.evaluate((element) => getComputedStyle(element).opacity)).toBe("1")
  await page.mouse.move(0, 0)
  await trigger.focus()
  expect(await arrow.evaluate((element) => getComputedStyle(element).opacity)).toBe("1")
  const touch = await browser.newPage({ hasTouch: true, viewport: { width: 375, height: 812 } })
  try {
    await touch.goto(url)
    await touch.getByText("I will check the project first.", { exact: true }).waitFor()
    await touch.evaluate(() => window.__conversationProcess.mode("full"))
    const arrow = touch
      .locator('[data-slot="process-reasoning-trigger"]')
      .first()
      .locator('[data-component="icon"]')
      .last()
    expect(await arrow.evaluate((element) => getComputedStyle(element).opacity)).toBe("1")
  } finally {
    await touch.close()
  }
}, 30000)

test("tools and reasoning share compact spacing across virtual chunks", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => {
    window.__conversationProcess.mode("full")
    window.__conversationProcess.grow(20)
  })
  const viewport = page.locator('[data-component="process-viewport"]').last()
  await viewport.waitFor()
  const triggers = viewport.locator('[data-slot="activity-step-trigger"]')
  await triggers.first().waitFor()
  await page.waitForFunction(() => !document.querySelector("[data-motion-changing]"))
  const geometry = await triggers.evaluateAll((elements) =>
    elements.slice(0, 8).map((element) => {
      const rect = element.getBoundingClientRect()
      return { top: rect.top, bottom: rect.bottom, height: rect.height }
    }),
  )
  expect(geometry.length).toBeGreaterThan(1)
  for (const [index, current] of geometry.entries()) {
    expect(current.height).toBe(32)
    if (index) expect(current.top - geometry[index - 1].bottom).toBe(2)
  }
})

test("completed live actions fade once while replay and remount stay static", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => window.__conversationProcess.mode("full"))
  const result = await page.evaluate(async () => {
    const animate = Element.prototype.animate
    const arrivals: { id: string | undefined; frames: unknown; duration: number | undefined }[] = []
    Element.prototype.animate = function (frames, options) {
      if (this.matches('[data-slot="activity-step"]'))
        arrivals.push({
          id: (this as HTMLElement).dataset.partId,
          frames,
          duration: typeof options === "object" ? Number(options.duration) : undefined,
        })
      return animate.call(this, frames, options)
    }
    const settle = async () => {
      for (let index = 0; index < 16; index++)
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
    try {
      window.__conversationProcess.append("live-completed")
      await settle()
      window.__conversationProcess.append("live-completed")
      window.__conversationProcess.append("replayed", "replay")
      await settle()
      window.__conversationProcess.remount()
      await settle()
      return arrivals
    } finally {
      Element.prototype.animate = animate
    }
  })
  expect(result).toEqual([{ id: "live-completed", frames: [{ opacity: 0.65 }, { opacity: 1 }], duration: 180 }])
})

test("loaded empty reasoning hides its control and a failed body keeps an accessible retry", async () => {
  await contentPage("mixed")
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => {
    window.__conversationProcess.mode("full")
    window.__conversationProcess.reasoning(" \n\t ")
  })
  await frames()
  expect(await page.locator('[data-component="process-reasoning"][data-part-id="thought"]').count()).toBe(0)
  const failed = page.locator("[data-display-row]").filter({ has: page.locator("[data-content-error]") })
  expect(await failed.getByRole("button", { name: "Retry loading content", exact: true }).count()).toBeGreaterThan(0)
  expect(await page.locator('[data-component="process-reasoning"][data-part-id="thought-2"]').count()).toBe(1)
})

test("process edge fades blend into the conversation canvas in both themes", async () => {
  try {
    for (const colorScheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme })
      await page.goto(url)
      await page.getByText("I will check the project first.", { exact: true }).waitFor()
      await page.waitForFunction((scheme) => document.documentElement.dataset.colorScheme === scheme, colorScheme)
      await page.evaluate(() => window.__conversationProcess.grow(50))
      const viewport = page.locator('[data-component="process-viewport"]').last()
      await viewport.evaluate((element) => {
        element.parentElement!.style.backgroundColor = "var(--background-stronger)"
        element.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }))
        element.scrollTop = (element.scrollHeight - element.clientHeight) / 2
      })
      await frames()
      const edges = await viewport.evaluate((element) => {
        const window = element.parentElement!
        return {
          canvas: getComputedStyle(window).backgroundColor,
          top: getComputedStyle(window, "::before").backgroundImage,
          bottom: getComputedStyle(window, "::after").backgroundImage,
          height: getComputedStyle(window, "::after").height,
          pointerEvents: getComputedStyle(window, "::after").pointerEvents,
        }
      })
      expect(edges.top).toContain(edges.canvas)
      expect(edges.bottom).toContain(edges.canvas)
      expect(edges.height).toBe("24px")
      expect(edges.pointerEvents).toBe("none")
    }
  } finally {
    await page.emulateMedia({ colorScheme: "no-preference" })
  }
})

test("recorded compaction retains its current label without generic activity metadata", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => {
    window.__conversationProcess.compaction("running")
    window.__conversationProcess.phase()
  })
  await frames()
  expect(await page.locator('[data-slot="turn-process-trigger"]').textContent()).toContain("Compressing context...")
  expect(await page.locator('[data-slot="activity-live-indicator"]').count()).toBe(0)
})

test("a live compaction without hydrated Parts creates one compact process window", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => {
    window.__conversationProcess.prepare()
    window.__conversationProcess.mode("full")
    window.__conversationProcess.compaction("running")
  })
  const event = page.locator('[data-component="process-event-row"]')
  await event.waitFor()
  await page.waitForFunction(() => document.querySelectorAll('[data-component="process-viewport"]').length === 1)
  expect(await event.count()).toBe(1)
  expect(await page.locator('[data-component="process-viewport"]').count()).toBe(1)
  expect(await event.locator("button").textContent()).toContain("Compressing context")
  expect(errors).toEqual([])
})

test("compaction has one compact lifecycle row and exposes running status while collapsed", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => {
    window.__conversationProcess.compaction("running")
    window.__conversationProcess.mode("minimal")
  })
  expect(await page.locator('[data-slot="turn-process-trigger"]').textContent()).toContain("Compressing context")
  await page.locator('[data-slot="turn-process-trigger"]').click()
  await page.locator('[data-component="conversation-activity"] > button').last().click()
  const card = page.locator('[data-component="compaction-card"]')
  await card.waitFor()
  expect(await card.count()).toBe(1)
  expect(await card.getAttribute("data-status")).toBe("running")
  expect(await card.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThanOrEqual(30)
  await page.evaluate(() => window.__conversationProcess.compaction("committed"))
  expect(await card.getAttribute("data-status")).toBe("complete")
  await card.locator("button").click()
  expect(await page.evaluate(() => window.__processSelection)).toEqual({
    kind: "compaction",
    sessionID: "session",
    messageID: "compression",
  })
  expect(await page.getByText("Compressed continuation", { exact: true }).count()).toBe(0)
}, 30000)

test("a manual compaction request is replaced by one completed event inside its process window", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => window.__conversationProcess.manualCompaction())
  const event = page.locator('[data-component="process-event-row"]')
  await event.waitFor()
  expect(await event.count()).toBe(1)
  expect(await event.getAttribute("data-status")).toBe("running")
  expect(await page.locator('[data-component="process-viewport"] [data-component="process-event-row"]').count()).toBe(1)
  await page.evaluate(() => window.__conversationProcess.compaction("committed"))
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-component="process-event-row"]').length === 1 &&
      document.querySelectorAll('[data-component="process-event-row"][data-status="complete"]').length === 1,
  )
  expect(await event.count()).toBe(1)
  expect(await page.locator('[data-component="process-event-row"][data-status="running"]').count()).toBe(0)
  await event.locator("button").click()
  expect(await page.evaluate(() => window.__processSelection)).toEqual({
    kind: "compaction",
    sessionID: "session",
    messageID: "compression",
  })
  expect(errors).toEqual([])
}, 30000)

test("logical execution folds across messages, preserves prose and retains the final Markdown through exit", async () => {
  const cdp = await page.context().newCDPSession(page)
  try {
    await page.goto(url)
    await page
      .getByText("I will check the project first.", { exact: true })
      .waitFor()
      .catch(async (error) => {
        throw new Error(JSON.stringify({ url: page.url(), errors, html: await page.content() }), { cause: error })
      })
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 })
    expect(await page.locator('[data-row-kind="activity"]').count()).toBe(2)
    expect(await page.locator('[data-component="conversation-activity"] > button').count()).toBe(2)
    expect(await page.locator('[data-component="process-viewport"]').count()).toBe(1)
    await page.evaluate(() => window.__conversationProcess.stream())
    await frames()
    await page.locator("[data-scroller]").evaluate((el) => (el.scrollTop = el.scrollHeight))
    await page
      .getByText("Final answer stays mounted.", { exact: true })
      .waitFor()
      .catch(async (error) => {
        throw new Error(await page.locator("#root").innerHTML(), { cause: error })
      })
    const answer = page.locator('[data-part-id="answer"] [data-component="markdown"]')
    await answer.waitFor()
    await answer.evaluate((element) => {
      window.answerNode = element
      window.__conversationProcess.terminal()
    })
    await frames()
    expect(await page.getByText("I will check the project first.", { exact: true }).count()).toBe(1)
    await page.evaluate(() => window.__conversationProcess.complete())
    await page.waitForFunction(() => !document.querySelector('[data-row-kind="activity"]'))
    await answer.waitFor()
    expect(
      await page.evaluate(() => ({
        captured: !!window.answerNode,
        connected: !!window.answerNode?.isConnected,
        same: window.answerNode === document.querySelector('[data-part-id="answer"] [data-component="markdown"]'),
      })),
    ).toEqual({ captured: true, connected: true, same: true })
    await page.locator('[data-slot="turn-process-trigger"]').click()
    await page
      .getByText("I will check the project first.", { exact: true })
      .waitFor()
      .catch(async (error) => {
        throw new Error(JSON.stringify({ errors, html: await page.locator("#root").innerHTML() }), { cause: error })
      })
    expect(await page.locator('[data-component="conversation-activity"] > button').count()).toBe(2)
    await page.locator('[data-component="conversation-activity"] > button').last().click()
    await page.locator('[data-slot="activity-step"]').nth(1).waitFor()
    expect(errors).toEqual([])
  } finally {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 })
    await cdp.detach()
  }
}, 60000)

test("preparing a turn reports submission without a premature Details-only footer", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => window.__conversationProcess.prepare())
  await frames()
  expect(await page.locator('[data-slot="turn-process-trigger"]').textContent()).toContain("Submitting message")
  expect(await page.locator('[data-component="execution-completion"]').count()).toBe(0)
  expect(await page.locator('[data-kind="copy-markdown"]').count()).toBe(0)
  expect(errors).toEqual([])
}, 30000)

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

test("folded process headers follow actual phases and parallel tool count", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  const trigger = page.locator('[data-slot="turn-process-trigger"]')
  await trigger.waitFor()
  if ((await trigger.getAttribute("aria-expanded")) === "true") await trigger.click()
  for (const [activity, label] of [
    [{ phase: "preparing_files", startedAt: 1, rootID: "root" }, "Preparing project files"],
    [{ phase: "waiting_model", startedAt: 2, rootID: "root" }, "Waiting for model response"],
    [
      { phase: "running_tools", startedAt: 3, rootID: "root", tool: { id: "read", count: 3 } },
      "Calling tools · 3 active",
    ],
  ] as const) {
    await page.evaluate((activity) => window.__conversationProcess.phase(activity), activity)
    await frames()
    await page.waitForFunction(
      (label) => document.querySelector('[data-slot="turn-process-trigger"]')?.textContent?.includes(label),
      label,
    )
    expect(await trigger.textContent()).toContain(label)
    expect(await trigger.getAttribute("aria-expanded")).toBe("false")
    expect(await page.locator('[data-slot="turn-process-trigger"]').count()).toBe(1)
  }
  expect(errors).toEqual([])
}, 30000)

test("streaming a text-only response keeps the current system status visible", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => window.__conversationProcess.respond())
  await frames()
  await page.getByText("Final answer stays mounted.", { exact: true }).waitFor()
  await page.waitForFunction(() =>
    document.querySelector('[data-slot="turn-process-trigger"]')?.textContent?.includes("Generating response"),
  )
  expect(await page.locator('[data-slot="turn-process-trigger"]').textContent()).toContain("Generating response")
  expect(await page.locator('[data-slot="turn-process-trigger"]').count()).toBe(1)
  expect(errors).toEqual([])
}, 30000)

test("tool objects retain paths and command prefixes without inventing modification evidence", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  const row = page.locator('[data-part-id^="case-"][data-slot="activity-step"]')
  await page.evaluate(() =>
    window.__conversationProcess.toolCase(
      "edit",
      { filePath: "/project/src/session/index.ts" },
      { filediff: { additions: 18, deletions: 7 } },
    ),
  )
  await row.getByText("index.ts", { exact: true }).waitFor()
  expect(await row.locator('[data-slot="activity-step-object"]').textContent()).toBe("src/session/index.ts")
  expect(await row.textContent()).not.toContain("Check the project directory")
  expect(await row.locator('[data-component="diff-changes"]').textContent()).toContain("+18")
  await page.evaluate(() =>
    window.__conversationProcess.toolCase("edit", { filePath: "/project/src/other/index.ts" }, {}, "error"),
  )
  expect(await row.locator('[data-component="diff-changes"]').count()).toBe(0)
  expect(await row.locator("button").getAttribute("aria-label")).toContain("Failed")
  expect(await row.textContent()).toContain("src/other/")
  await page.evaluate(() =>
    window.__conversationProcess.toolCase(
      "bash",
      { command: "echo 'changed' > src/index.ts" },
      { filediff: { additions: 18, deletions: 7 } },
    ),
  )
  expect(await row.locator('[data-slot="activity-step-object"]').textContent()).toBe("echo 'changed' > src/index.ts")
  expect(await row.locator('[data-component="diff-changes"]').count()).toBe(0)
  await page.evaluate(() =>
    window.__conversationProcess.toolCase("grep", { pattern: "ProcessViewport", path: "apps/web" }, {}),
  )
  expect(await row.textContent()).toContain("ProcessViewport · apps/web")
  await page.evaluate(() => window.__conversationProcess.toolCase("custom_lookup", {}, {}))
  expect(await row.textContent()).toContain("Check the project directory")
  expect(await row.textContent()).not.toContain("undefined")
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
