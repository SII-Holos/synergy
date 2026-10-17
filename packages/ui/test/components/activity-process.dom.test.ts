import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { ReasoningPart } from "@ericsanchezok/synergy-sdk/client"
import { JSDOM } from "jsdom"
import { domFixture } from "../support/dom-fixtures"

type Harness = {
  reset: (completed?: number, running?: number) => void
  setMode: (mode: "balanced" | "full" | "minimal") => void
  setActive: (value: boolean) => void
  setFollowing: (value: boolean) => void
  setTools: (completed: number, running?: number) => void
  setReasoning: (entries: ReasoningPart[]) => void
  setPreview: (value: boolean) => void
  setLocale: (locale: "en" | "zh-CN") => void
  openedTools: string[]
}
let dom: JSDOM
let harness: Harness
const update = () => new Promise((resolve) => setTimeout(resolve, 0))
const visibleTools = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-slot="activity-step"]')).filter((row) => !row.hidden)
const history = () => document.querySelector<HTMLButtonElement>('[data-slot="activity-batch-trigger"]')!

beforeAll(async () => {
  const entry = await domFixture("activity-process.dom")
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost/" })
  const window = dom.window
  const computed = window.getComputedStyle.bind(window)
  window.getComputedStyle = ((element) => {
    const style = computed(element)
    Object.defineProperty(style, "animationName", { configurable: true, value: "none" })
    return style
  }) as typeof window.getComputedStyle
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia
  window.HTMLElement.prototype.scrollTo = function (options) {
    this.scrollTop = typeof options === "object" ? (options.top ?? 0) : (options ?? 0)
  }
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    SVGElement: window.SVGElement,
    customElements: window.customElements,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    MutationObserver: window.MutationObserver,
    ResizeObserver: ResizeObserverStub,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  })
  await import(entry)
  harness = (globalThis as typeof globalThis & { __activityProcessHarness: Harness }).__activityProcessHarness
}, 60000)
afterAll(() => dom?.window.close())
beforeEach(async () => {
  harness.setLocale("en")
  harness.reset()
  await update()
})

describe("continuous activity presentation", () => {
  test("completed calls are collected while the current call stays visible", async () => {
    expect(history().getAttribute("aria-expanded")).toBe("false")
    expect(history().textContent).toContain("Ran 20 commands")
    expect(visibleTools().map((row) => row.textContent?.trim())).toEqual(["Check project evidence 21"])
    const current = visibleTools()[0]
    history().click()
    await update()
    expect(visibleTools()).toHaveLength(21)
    expect(visibleTools().at(-1)).toBe(current)
    harness.setTools(21)
    await update()
    expect(history().getAttribute("aria-expanded")).toBe("true")
    expect(visibleTools()).toHaveLength(22)
    expect(document.contains(current)).toBe(true)
  })
  test("a new call does not remount the previous call and selection remains invocation-owned", async () => {
    const current = visibleTools()[0]
    const button = current.querySelector<HTMLButtonElement>("button")!
    button.click()
    harness.setTools(21)
    await update()
    expect(document.contains(current)).toBe(true)
    expect(current.hidden).toBe(true)
    expect(visibleTools().at(-1)?.textContent).toContain("evidence 22")
    expect(harness.openedTools.at(-1)).toBe("tool-20")
  })
  test("detached reading retains the visible call through completion and return to latest releases it", async () => {
    const current = visibleTools()[0]
    harness.setFollowing(false)
    await update()
    harness.setTools(21)
    await update()
    expect(current.hidden).toBe(false)
    harness.setActive(false)
    await update()
    expect(current.hidden).toBe(false)
    harness.setFollowing(true)
    await update()
    expect(visibleTools()).toHaveLength(0)
    expect(history().getAttribute("aria-expanded")).toBe("false")
  })
  test("history remains bounded and an earlier page stays selected as tools arrive", async () => {
    harness.reset(60)
    history().click()
    await update()
    expect(visibleTools().length).toBeLessThanOrEqual(25)
    const previous = document.querySelector<HTMLButtonElement>('[data-slot="activity-history-earlier"]')!
    previous.click()
    await update()
    expect(visibleTools()[0].textContent).toContain("evidence 14")
    const first = visibleTools()[0]
    harness.setTools(61)
    await update()
    expect(visibleTools()[0]).toBe(first)
    expect(document.querySelectorAll('[data-slot="activity-step"]').length).toBeLessThanOrEqual(26)
  })
  test("all display modes share rows and an explicit history choice survives changes", async () => {
    const current = visibleTools()[0]
    harness.setMode("full")
    await update()
    expect(visibleTools()).toHaveLength(21)
    expect(visibleTools().at(-1)).toBe(current)
    history().click()
    await update()
    for (const mode of ["balanced", "minimal", "full"] as const) {
      harness.setMode(mode)
      await update()
      expect(history().getAttribute("aria-expanded")).toBe("false")
      expect(visibleTools()).toEqual([current])
    }
  })
  test("parallel running calls remain visible in their original order", async () => {
    harness.reset(20, 3)
    await update()
    expect(visibleTools().map((row) => row.textContent?.trim())).toEqual([
      "Check project evidence 21",
      "Check project evidence 22",
      "Check project evidence 23",
    ])
  })
  test("a focused tool remains keyboard reachable as the next call starts", async () => {
    const current = visibleTools()[0]
    const button = current.querySelector<HTMLButtonElement>("button")!
    button.focus()
    harness.setTools(21)
    await update()
    expect(current.hidden).toBe(false)
    expect(document.activeElement === button).toBe(true)
    history().focus()
    await update()
    expect(current.hidden).toBe(true)
  })
})

test("reasoning is grouped by model reply and manual expansion preserves its reading position", async () => {
  const detail = document.querySelector<HTMLElement>('[data-slot="process-reasoning-detail"]')!
  Object.defineProperties(detail, {
    scrollHeight: { configurable: true, value: 1200 },
    clientHeight: { configurable: true, value: 200 },
  })
  document.querySelector<HTMLButtonElement>('[data-slot="process-reasoning-trigger"]')!.click()
  await update()
  await update()
  const segments = Array.from(document.querySelectorAll('[data-slot="reasoning-segment"]'))
  expect(segments).toHaveLength(3)
  expect(
    segments.map((segment) => segment.querySelector('[data-slot="reasoning-segment-heading"]')?.textContent),
  ).toEqual(["Reasoning 1", "Reasoning 2", "Reasoning 3"])
  expect(detail.scrollTop).toBe(0)
  detail.scrollTop = 100
  detail.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -100 }))
  harness.setReasoning([
    {
      id: "new-reasoning",
      sessionID: "activity-process",
      messageID: "assistant-new",
      type: "reasoning",
      text: "Current reasoning",
      time: { start: 4 },
    },
  ])
  await update()
  expect(detail.scrollTop).toBe(100)
  document.querySelector<HTMLButtonElement>('[data-slot="reasoning-latest"]')!.click()
  await update()
  expect(detail.scrollTop).toBe(1200)
})

test("multiple reasoning parts in one reply share a section and keyboard reading pauses following", async () => {
  const entries = Array.from(
    { length: 3 },
    (_, index): ReasoningPart => ({
      id: `reasoning-${index}`,
      sessionID: "activity-process",
      messageID: index < 2 ? "reply-one" : "reply-two",
      type: "reasoning",
      text: `Preserved reasoning ${index}`,
      time: { start: index },
    }),
  )
  harness.setReasoning(entries)
  await update()
  const detail = document.querySelector<HTMLElement>('[data-slot="process-reasoning-detail"]')!
  document.querySelector<HTMLButtonElement>('[data-slot="process-reasoning-trigger"]')!.click()
  await update()
  await update()
  const sections = document.querySelectorAll('[data-slot="reasoning-segment"]')
  expect(sections).toHaveLength(2)
  expect(sections[0].querySelectorAll("[data-reasoning-part]")).toHaveLength(2)
  const original = sections[0].querySelector("[data-reasoning-part]")
  detail.scrollTop = 120
  detail.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "PageUp", bubbles: true }))
  harness.setReasoning(
    entries.map((entry) => (entry.id === "reasoning-2" ? { ...entry, text: entry.text + " new delta" } : entry)),
  )
  await update()
  expect(detail.scrollTop).toBe(120)
  expect(sections[0].querySelector("[data-reasoning-part]") === original).toBe(true)
})

test("collapsed reasoning preview reflects the latest model reply", async () => {
  harness.setPreview(true)
  await update()
  const preview = document.querySelector('[data-slot="process-reasoning-preview"]')!
  expect(preview.textContent).toBe("Reasoning from call 3")
  harness.setReasoning([
    {
      id: "reasoning-new",
      sessionID: "activity-process",
      messageID: "reply-new",
      type: "reasoning",
      text: "New finding to verify\nAdditional detail",
      time: { start: 5 },
    },
  ])
  await update()
  expect(preview.textContent).toBe("New finding to verify")
})

test("reasoning and history controls react to locale changes while raw content stays verbatim", async () => {
  harness.reset(60)
  history().click()
  document.querySelector<HTMLButtonElement>('[data-slot="process-reasoning-trigger"]')!.click()
  await update()
  harness.setLocale("zh-CN")
  await update()
  expect(document.querySelector('[data-slot="activity-history-earlier"]')?.textContent).toBe("先前的操作")
  expect(document.querySelector('[data-slot="reasoning-latest"]')?.textContent).toBe("最新推理")
  expect(document.querySelector('[data-slot="reasoning-segment-heading"]')?.textContent).toBe("第 1 段推理")
  expect(document.querySelector('[data-reasoning-part="reasoning-0"]')?.textContent).toBe("Reasoning from call 1")
  expect(visibleTools().at(-1)?.textContent).toContain("Check project evidence 61")
})

const progressCount = () =>
  document.querySelector('[data-slot="process-reasoning-progress"] [data-slot="activity-count-new"]')
const progressUnit = () => document.querySelector('[data-slot="process-reasoning-progress-unit"]')
const reasoningLabel = () => document.querySelector('[data-slot="process-reasoning-label"]')
const reasoningTrigger = () => document.querySelector<HTMLButtonElement>('[data-slot="process-reasoning-trigger"]')!
const reasoningPart = (id: string, messageID: string, text: string, end?: number): ReasoningPart => ({
  id,
  sessionID: "activity-process",
  messageID,
  type: "reasoning",
  text,
  time: end === undefined ? { start: 1 } : { start: 1, end },
})

test("reasoning progress counts generated words and keeps the final cumulative value", async () => {
  harness.setReasoning([reasoningPart("r-progress", "reply-1", "We should check")])
  await update()
  expect(reasoningLabel()?.textContent).toBe("Thinking")
  expect(progressCount()?.textContent).toBe("3")
  expect(progressUnit()?.textContent).toBe("generated words")
  expect(reasoningTrigger().getAttribute("aria-label")).toBe("View reasoning. Thinking, 3 generated words")

  harness.setReasoning([reasoningPart("r-progress", "reply-1", "We should check", 9)])
  await update()
  expect(reasoningLabel()?.textContent).toBe("Reasoning")
  expect(progressCount()?.textContent).toBe("3")
  expect(reasoningTrigger().getAttribute("aria-label")).toBe("View reasoning. Reasoning, 3 generated words")
})

test("a single generated word uses singular plural copy", async () => {
  harness.setReasoning([reasoningPart("r-one", "reply-1", "Knowledge", 9)])
  await update()
  expect(progressCount()?.textContent).toBe("1")
  expect(progressUnit()?.textContent).toBe("generated word")
  expect(reasoningTrigger().getAttribute("aria-label")).toBe("View reasoning. Reasoning, 1 generated word")
})

test("punctuation-only reasoning shows no progress and keeps the plain label", async () => {
  harness.setReasoning([reasoningPart("r-empty", "reply-1", "... --- ***", 9)])
  await update()
  expect(document.querySelector('[data-slot="process-reasoning-progress"]')).toBeNull()
  expect(reasoningLabel()?.textContent).toBe("Reasoning")
  expect(reasoningTrigger().getAttribute("aria-label")).toBe("View reasoning")
})

test("multiple canonical parts sum in order while raw details stay verbatim", async () => {
  harness.setReasoning([
    reasoningPart("r-a", "reply-1", "First reasoning line", 9),
    reasoningPart("r-b", "reply-1", "Second reasoning line", 9),
    reasoningPart("r-c", "reply-2", "世界", 9),
  ])
  await update()
  expect(progressCount()?.textContent).toBe("7")

  reasoningTrigger().click()
  await update()
  await update()
  expect(document.querySelectorAll('[data-slot="reasoning-segment"]')).toHaveLength(2)
  expect(document.querySelector('[data-reasoning-part="r-a"]')?.textContent).toBe("First reasoning line")
  expect(document.querySelector('[data-reasoning-part="r-c"]')?.textContent).toBe("世界")
})

test("large counts keep locale number grouping while the unit copy stays fixed", async () => {
  harness.setReasoning([reasoningPart("r-big", "reply-1", "word ".repeat(1234).trim(), 9)])
  await update()
  expect(progressCount()?.textContent).toBe("1,234")
  expect(progressUnit()?.textContent).toBe("generated words")
})

test("progress follows the active locale and locale change keeps one number node", async () => {
  harness.setReasoning([reasoningPart("r-zh", "reply-1", "我们需要检查证据", 9)])
  await update()
  const number = document.querySelector(
    '[data-slot="process-reasoning-progress"] [data-component="animated-activity-count"]',
  )
  expect(progressCount()?.textContent).toBe("4")

  harness.setLocale("zh-CN")
  await update()
  expect(progressUnit()?.textContent).toBe("个词")
  expect(reasoningLabel()?.textContent).toBe("推理")
  expect(reasoningTrigger().getAttribute("aria-label")).toBe("查看推理。推理，已生成 4 个词")
  expect(
    document.querySelector('[data-slot="process-reasoning-progress"] [data-component="animated-activity-count"]'),
  ).toBe(number)
  expect(
    document.querySelectorAll('[data-slot="process-reasoning-progress"] [data-slot="activity-count-new"]'),
  ).toHaveLength(1)
})

test("rapid progress updates keep one stable number node and settle on the newest value", async () => {
  harness.setReasoning([reasoningPart("r-rapid", "reply-1", "alpha")])
  await update()
  const number = document.querySelector(
    '[data-slot="process-reasoning-progress"] [data-component="animated-activity-count"]',
  )
  expect(progressCount()?.textContent).toBe("1")

  harness.setReasoning([reasoningPart("r-rapid", "reply-1", "alpha beta gamma")])
  await update()
  expect(
    document.querySelector('[data-slot="process-reasoning-progress"] [data-component="animated-activity-count"]'),
  ).toBe(number)
  expect(progressCount()?.textContent).toBe("3")
  expect(
    document.querySelectorAll('[data-slot="process-reasoning-progress"] [data-slot="activity-count-new"]'),
  ).toHaveLength(1)
})

test("the disclosure keeps expanded/controls wiring, its accessible name and no extra live region", async () => {
  harness.reset()
  await update()
  const trigger = reasoningTrigger()
  expect(trigger.tagName).toBe("BUTTON")
  expect(trigger.getAttribute("aria-expanded")).toBe("false")
  expect(trigger.getAttribute("aria-controls")).toBeTruthy()
  expect(progressCount()?.textContent).toBe("12")
  expect(trigger.getAttribute("aria-label")).toBe("View reasoning. Reasoning, 12 generated words")

  const progress = document.querySelector('[data-slot="process-reasoning-progress"]')!
  expect(progress.getAttribute("aria-live")).toBeNull()
  expect(progress.getAttribute("role")).toBeNull()

  trigger.click()
  await update()
  expect(trigger.getAttribute("aria-expanded")).toBe("true")
  expect(trigger.getAttribute("aria-label")).toBe("Hide reasoning. Reasoning, 12 generated words")
  expect(document.getElementById(trigger.getAttribute("aria-controls")!)).not.toBeNull()
})
