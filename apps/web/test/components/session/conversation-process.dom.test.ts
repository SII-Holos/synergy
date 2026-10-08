import { afterAll, beforeAll, expect, test } from "bun:test"
import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { createRequire } from "node:module"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import type { VListHandle } from "virtua/solid"

type Fixture = {
  append(id: string, source?: "live" | "replay"): void
  remount(): void
  reasoning(text: string, partID?: string): void

  fragments(count: number): void
  toolCase(
    tool: string,
    input: Record<string, unknown>,
    metadata: Record<string, unknown>,
    status?: "completed" | "error",
  ): void
  prepare(): void
  respond(): void
  phase(value?: {
    phase: "waiting_model" | "running_tools" | "preparing_files" | "stopping"
    startedAt: number
    rootID?: string
    tool?: { id?: string; count: number }
  }): void
  connected(value: boolean): void
  approval(value: boolean): void
  stream(): void
  terminal(): void
  complete(): void
  grow(count: number): void
  restoreProcess(count: number): void
  backfill(count: number): void
  hydrateBefore(count: number): void
  growReadingParagraph(id: string, count: number): void
  growToolEvidence(id: string): void
  latest(): void
  prependTurns(count: number): void
  prepend(count: number): void
  delivery(): void
  manualCompaction(): void
  compaction(state: "running" | "committed" | "failed"): void
  mode(value: "balanced" | "full" | "minimal"): void
  locate(messageID: string, partID?: string): Promise<boolean>
  reading(value: boolean): void
  retained(): number
  summaryReads(): number
  contentRecover(id: string): void
  contentPending(id: string): void
  contentFinish(id: string): void
  contentReads(id: string): number
  contentReconnect(): void
  contentPageFinish(): void
  contentStale(): void
  contentPageLoads(): number
}
declare global {
  interface Window {
    __conversationProcess: Fixture
    answerNode?: Element | null
    __processSelection?: unknown
    __activityTitle?: Element | null
    __activityFacts?: Element | null

    __resizeErrors: string[]
    __conversationResizeList?: VListHandle
  }
}
let server: ViteDevServer, browser: Browser, page: Page, directory: string, url: string
const errors: string[] = []
const app = path.resolve(import.meta.dir, "../../..")
const require = createRequire(import.meta.url)
const virtualizer = path.join(path.dirname(require.resolve("virtua/package.json")), "lib/solid")
const observeResizeErrors = (target: Page) =>
  target.addInitScript(() => {
    window.__resizeErrors = []
    window.addEventListener("error", (event) => {
      if (event.message.includes("ResizeObserver")) window.__resizeErrors.push(event.message)
    })
  })
const fixtureServer = async (entry: "index.mjs" | "index.jsx") => {
  const server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, `.vite-${entry}`),
    plugins: [solid()],
    resolve: {
      alias: [
        { find: /^virtua\/solid$/, replacement: path.join(virtualizer, entry) },
        { find: "@/context/execution", replacement: path.join(directory, "execution.ts") },
      ],
    },
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
  return server
}
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
    '<!doctype html><style>body{font:16px/24px system-ui}button{font:inherit}[data-component="session-turn"]{height:auto}[data-slot="session-turn-content"]{height:auto!important}</style><div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `import ${JSON.stringify(`/@fs/${app}/test/fixtures/conversation/process.tsx`)}`,
  )
  await Bun.write(
    path.join(directory, "execution.ts"),
    "export const useExecution=()=>({available:()=>true,round:()=>undefined,open:()=>{}})",
  )
  await Bun.write(
    path.join(directory, "resize.html"),
    '<!doctype html><div id="root"></div><script type="module" src="/resize.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "resize.tsx"),
    `import {createSignal} from "solid-js"
    import {render} from "solid-js/web"
    import {VList} from "virtua/solid"
    const [hidden,setHidden]=createSignal(false)
    render(()=><><button onClick={()=>setHidden(!hidden())}>Toggle list</button>
      <div style={{height:"288px",width:"320px",display:hidden()?"none":"block"}}>
        <VList style={new URL(location.href).searchParams.has("fixed")?{position:"fixed",height:"288px",width:"320px"}:undefined} ref={value=>window.__conversationResizeList=value} data={Array.from({length:100},(_,i)=>i)} itemSize={48} overscan={2} aria-label="Measured list">
          {item=><button style={{height:"48px",width:"100%",display:"block"}}>Item {item}</button>}
        </VList>
      </div></>,document.getElementById("root"))`,
  )
  server = await fixtureServer("index.mjs")
  url = server.resolvedUrls!.local[0]!
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  await observeResizeErrors(page)
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
    const fixture = await fixtureServer(entry)
    try {
      await page.goto(`${fixture.resolvedUrls!.local[0]}resize.html?fixed`)
      await page.getByRole("button", { name: "Item 0", exact: true }).waitFor()
      await frames()
      expect(await page.evaluate(() => window.__conversationResizeList!.viewportSize)).toBe(288)
      await page.evaluate(() => window.__conversationResizeList!.scrollToIndex(80, { align: "start" }))
      await page.getByRole("button", { name: "Item 80", exact: true }).waitFor()
      const hit = await page.getByLabel("Measured list").evaluate(async (element) => {
        element.scrollTop += 48
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        const rect = element.getBoundingClientRect()
        return element.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + 24))
      })
      expect(hit).toBe(true)
      expect(errors).toEqual([])
    } finally {
      await fixture.close()
    }
  },
  30000,
)

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

test.each(["index.mjs", "index.jsx"] as const)(
  "history hydration, hidden lists and process disclosure retain measured geometry (%s)",
  async (entry) => {
    const alternate = entry === "index.jsx" ? await fixtureServer(entry) : undefined
    const target = alternate ? await browser.newPage() : page
    target.setDefaultTimeout(15000)
    if (alternate) target.on("pageerror", (error) => errors.push(error.message))
    await observeResizeErrors(target)
    try {
      const base = alternate?.resolvedUrls!.local[0]! ?? url
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
      await target.goto(alternate?.resolvedUrls!.local[0]! ?? url)
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
  expect(await page.locator('[data-slot="process-latest"]').last().textContent()).toBe("")
  await viewport.focus()
  await viewport.press("End")
  await page.locator('[data-slot="process-latest"]').waitFor({ state: "detached" })
  expect(await page.evaluate(() => window.__conversationProcess.retained())).toBeLessThan(120)
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
  await page
    .getByRole("link", { name: "Project reference 59", exact: true })
    .evaluate((element) => (element as HTMLElement).focus({ preventScroll: true }))
  await page.evaluate(() => window.__conversationProcess.latest())
  for (let index = 0; index < 4; index++) await frames()
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
  await page.locator('[data-slot="process-latest"]').last().waitFor({ state: "visible" })
})

test("native Space paging preserves new reading when real body growth follows its first movement", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => window.__conversationProcess.grow(1000))
  await page.evaluate(() => window.__conversationProcess.locate("more", "many-400"))
  const viewport = page.locator('[data-component="process-viewport"]').last()
  await viewport.focus()
  for (let index = 0; index < 4; index++) await frames()
  const before = await viewport.evaluate((element) => {
    element.addEventListener(
      "scroll",
      () => {
        window.__conversationProcess.growToolEvidence("many-400")
      },
      { once: true },
    )
    return { top: element.scrollTop, height: element.scrollHeight }
  })
  await viewport.press("Space")
  for (let index = 0; index < 12; index++) await frames()
  const after = await viewport.evaluate((element) => ({ top: element.scrollTop, height: element.scrollHeight }))
  expect(await viewport.locator('[data-part-id="many-400"] [data-slot="activity-evidence"]').count()).toBe(1)
  expect(after.height).toBeGreaterThan(before.height)
  expect(after.top).toBeGreaterThan(before.top + 100)
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
      const height = original.querySelector<HTMLElement>('[data-slot="process-viewport-content"] > div')!.style.height
      const first = await new Promise<string>((resolve) => {
        const observer = new MutationObserver(() => {
          const current = [...document.querySelectorAll<HTMLElement>('[data-component="process-viewport"]')].at(-1)
          if (!current || current === original) return
          const content = current.querySelector<HTMLElement>('[data-slot="process-viewport-content"] > div')
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
  await page.evaluate(() => window.__conversationProcess.append("live-reading-append"))
  await frames()
  await frames()
  expect(Math.abs((await part.evaluate((el) => el.getBoundingClientRect().top)) - before)).toBeLessThan(2)
  expect(await page.locator("[data-scroller]").evaluate((el) => el.scrollTop)).toBe(outer)
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
  await page.locator('[data-slot="process-latest"]').last().click()
  await page.waitForFunction(() => {
    const part = document.querySelector('[data-part-id="live-reading-append"]')
    const viewport = part?.closest('[data-component="process-viewport"]')
    if (!part || !viewport) return false
    const bounds = viewport.getBoundingClientRect(),
      row = part.getBoundingClientRect()
    return row.height > 0 && row.bottom > bounds.top && row.top < bounds.bottom
  })
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
