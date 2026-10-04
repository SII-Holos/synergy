import { afterAll, beforeAll, expect, test } from "bun:test"
import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

type Fixture = {
  toolCase(
    tool: string,
    input: Record<string, unknown>,
    metadata: Record<string, unknown>,
    status?: "completed" | "error",
  ): void
  prepare(): void
  respond(): void
  phase(value: {
    phase: "waiting_model" | "running_tools" | "preparing_files"
    startedAt: number
    rootID?: string
    tool?: { id?: string; count: number }
  }): void
  stream(): void
  terminal(): void
  complete(): void
  grow(count: number): void
  hydrateBefore(count: number): void
  prepend(count: number): void
  delivery(): void
  manualCompaction(): void
  compaction(state: "running" | "committed" | "failed"): void
  mode(value: "balanced" | "full" | "minimal"): void
  locate(messageID: string, partID?: string): Promise<boolean>
  reading(value: boolean): void
  retained(): number
  contentRecover(id: string): void
  contentPending(id: string): void
  contentFinish(id: string): void
  contentReads(id: string): number
  contentReconnect(): void
}
declare global {
  interface Window {
    __conversationProcess: Fixture
    answerNode?: Element | null
    __processSelection?: unknown
  }
}
let server: ViteDevServer, browser: Browser, page: Page, directory: string, url: string
const errors: string[] = []
const app = path.resolve(import.meta.dir, "../../..")
const frames = () =>
  page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  )
const contentPage = async (scenario: string) => {
  await page.close()
  page = await browser.newPage()
  page.setDefaultTimeout(15000)
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(`${url}?content=${scenario}`)
}
beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".conversation-process-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<style>body{font:16px/24px system-ui}button{font:inherit}[data-component="session-turn"]{height:auto}[data-slot="session-turn-content"]{height:auto!important}</style><div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `import ${JSON.stringify(`/@fs/${app}/test/fixtures/conversation/process.tsx`)}`,
  )
  await Bun.write(
    path.join(directory, "execution.ts"),
    "export const useExecution=()=>({available:()=>true,round:()=>undefined,open:()=>{}})",
  )
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, ".vite"),
    plugins: [solid()],
    resolve: { alias: [{ find: "@/context/execution", replacement: path.join(directory, "execution.ts") }] },
    server: {
      hmr: false,
      host: "127.0.0.1",
      port: await fixturePort(),
      strictPort: true,
      fs: { allow: [path.resolve(app, "../.."), directory] },
    },
  })
  await server.listen()
  await server.warmupRequest("/main.tsx")
  url = server.resolvedUrls!.local[0]!
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.setDefaultTimeout(15000)
  page.on("pageerror", (e) => {
    errors.push(e.message)
    console.error(e.stack)
  })
  await page.goto(url, { timeout: 60000 })
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
}, 90000)
afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
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
  expect(await page.getByText("I will check the project first.", { exact: true }).count()).toBe(1)
}, 30000)

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
  await page.getByText("More actions below", { exact: true }).waitFor()
  expect(await page.locator('[data-slot="process-latest"]').count()).toBe(0)
  await viewport.focus()
  await viewport.press("End")
  await page.getByText("More actions below", { exact: true }).waitFor({ state: "detached" })
  expect(await page.evaluate(() => window.__conversationProcess.retained())).toBeLessThan(120)
})

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
  await frames()
  await page.locator('[data-part-id="many-61"]').waitFor()
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

test("a process locator opens a closed group and finds an offscreen part in its own viewport", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => {
    window.__conversationProcess.grow(1000)
    window.__conversationProcess.mode("minimal")
  })
  expect(await page.evaluate(() => window.__conversationProcess.locate("more", "many-400"))).toBe(true)
  const part = page.locator('[data-part-id="many-400"]')
  await part.waitFor()
  expect(
    await part.evaluate((el) => {
      const viewport = el.closest('[data-component="process-viewport"]')!
      const bounds = viewport.getBoundingClientRect(),
        row = el.getBoundingClientRect()
      return row.bottom > bounds.top && row.top < bounds.bottom
    }),
  ).toBe(true)
}, 30000)

test("local reading survives new actions, history prepend and reopening without moving the outer stream", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => window.__conversationProcess.grow(1000))
  await page.evaluate(() => window.__conversationProcess.locate("more", "many-400"))
  const viewport = page.locator('[data-component="process-viewport"]').last()
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
  const part = page.locator('[data-slot="activity-step"][data-part-id="many-400"]')
  const before = await part.evaluate((el) => el.getBoundingClientRect().top)
  const outer = await page.locator("[data-scroller]").evaluate((el) => el.scrollTop)
  await page.evaluate(() => window.__conversationProcess.prepend(24))
  await frames()
  expect(Math.abs((await part.evaluate((el) => el.getBoundingClientRect().top)) - before)).toBeLessThan(2)
  expect(await page.locator("[data-scroller]").evaluate((el) => el.scrollTop)).toBe(outer)
  await page.locator('[data-slot="process-latest"]').last().waitFor()
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
}, 30000)

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
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 })
  try {
    await page.goto(url)
    await page
      .getByText("I will check the project first.", { exact: true })
      .waitFor()
      .catch(async (error) => {
        throw new Error(JSON.stringify({ url: page.url(), errors, html: await page.content() }), { cause: error })
      })
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

test("reconnect renews invalidated body leases even when the summary version stays the same", async () => {
  await contentPage("conflict")
  await page.waitForFunction(() => window.__conversationProcess.contentReads("progress") === 2)
  await page.evaluate(() => window.__conversationProcess.contentReconnect())
  await page.waitForFunction(() => window.__conversationProcess.contentReads("progress") === 3)
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
