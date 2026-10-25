import { expect, test } from "bun:test"
import { page, url, errors } from "../../support/conversation-process"
import { testOptions } from "../../../script/test-options"

const nextFrame = () =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve())
        }),
      ),
  )

test(
  "diagnostic: bottom wheel input and follow motion",
  async () => {
    await page.goto(`${url}?scrolling&motion&content=long-history`)
    await page.evaluate(() => window.__conversationProcess.latest())
    await page.waitForFunction(() => {
      const viewport = document.querySelector<HTMLElement>("[data-scroller]")
      return (
        !!viewport &&
        viewport.scrollHeight > viewport.clientHeight &&
        Math.abs(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop) < 1
      )
    })
    await page.waitForFunction(() => !document.querySelector("[data-follow-motion]")?.getAnimations().length)

    const box = await page.locator("[data-scroller]").boundingBox()
    if (!box) throw new Error("scroll fixture has no viewport bounds")
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)

    const sample = (phase: string) =>
      page.evaluate((phase) => {
        const viewport = document.querySelector<HTMLElement>("[data-scroller]")!
        const motion = document.querySelector<HTMLElement>("[data-follow-motion]")!
        return {
          phase,
          scrollTop: viewport.scrollTop,
          max: viewport.scrollHeight - viewport.clientHeight,
          gap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
          motionTop: motion.getBoundingClientRect().top,
          transform: getComputedStyle(motion).transform,
          animations: motion.getAnimations().map((animation) => ({
            playState: animation.playState,
            currentTime: animation.currentTime,
          })),
        }
      }, phase)
    const samples = [await sample("initial")]

    await page.mouse.wheel(0, -1800)
    for (let frame = 0; frame < 8; frame++) {
      await nextFrame()
      samples.push(await sample(`up-${frame}`))
    }

    for (let step = 0; step < 8; step++) {
      await page.mouse.wheel(0, 900)
      for (let frame = 0; frame < 4; frame++) {
        await nextFrame()
        samples.push(await sample(`down-${step}-${frame}`))
      }
    }

    for (let frame = 0; frame < 20; frame++) {
      await nextFrame()
      samples.push(await sample(`settle-${frame}`))
    }

    expect(errors).toEqual([])
  },
  testOptions.isolatedTimeoutMs,
)

test(
  "diagnostic: active growth after reaching the bottom",
  async () => {
    await page.goto(`${url}?scrolling&motion`)
    await page.getByText("I will check the project first.", { exact: true }).waitFor()
    await page.locator("[data-scroller]").evaluate((element) => {
      ;(element as HTMLElement).style.height = "300px"
    })
    await page.evaluate(() => window.__conversationProcess.latest())
    await page.waitForFunction(() => {
      const viewport = document.querySelector<HTMLElement>("[data-scroller]")
      return (
        !!viewport &&
        viewport.scrollHeight > viewport.clientHeight &&
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 1
      )
    })
    await page.waitForFunction(
      () => document.querySelector<HTMLElement>("[data-scroller]")?.dataset.hydrated === "true",
    )
    await page.waitForFunction(() => !document.querySelector("[data-follow-motion]")?.getAnimations().length)

    const box = await page.locator("[data-scroller]").boundingBox()
    if (!box) throw new Error("scroll fixture has no viewport bounds")
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, 900)
    await nextFrame()
    await page.evaluate(() => {
      const calls: string[] = []
      const original = Element.prototype.animate
      Element.prototype.animate = function (this: Element, ...args: Parameters<Element["animate"]>) {
        const owner = this.getAttribute("data-follow-motion") !== null ? "conversation" : "other"
        calls.push(`${owner}:${JSON.stringify(args[0])}`)
        return original.apply(this, args)
      }
      const target = window as Window & { __motionCalls?: string[]; __restoreMotion?: () => void }
      target.__motionCalls = calls
      target.__restoreMotion = () => {
        Element.prototype.animate = original
        target.__restoreMotion = undefined
      }
      window.__conversationProcess.stream(
        "The completed answer keeps growing after the reader reaches the bottom. ".repeat(120),
      )
    })
    await page.mouse.wheel(0, 900)

    const samples = []
    for (let frame = 0; frame < 30; frame++) {
      await nextFrame()
      samples.push(
        await page.evaluate((phase) => {
          const viewport = document.querySelector<HTMLElement>("[data-scroller]")!
          const motion = document.querySelector<HTMLElement>("[data-follow-motion]")!
          return {
            phase,
            scrollTop: viewport.scrollTop,
            max: viewport.scrollHeight - viewport.clientHeight,
            gap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
            rows: viewport.querySelectorAll("[data-display-row]").length,
            answer: viewport.textContent?.includes("The completed answer keeps growing") ?? false,
            animateCalls: (window as Window & { __motionCalls?: string[] }).__motionCalls?.length ?? 0,
            reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
            animateType: typeof motion.animate,
            motionHeight: motion.getBoundingClientRect().height,
            motionScrollHeight: motion.scrollHeight,
            motionTop: motion.getBoundingClientRect().top,
            transform: getComputedStyle(motion).transform,
            animations: motion.getAnimations().map((animation) => animation.currentTime),
          }
        }, `growth-${frame}`),
      )
    }

    const conversationCalls = await page.evaluate(() =>
      ((window as Window & { __motionCalls?: string[] }).__motionCalls ?? []).filter((call) =>
        call.startsWith("conversation:"),
      ),
    )
    await page.evaluate(() => (window as Window & { __restoreMotion?: () => void }).__restoreMotion?.())
    expect(conversationCalls).toEqual([])
    expect(errors).toEqual([])
  },
  testOptions.isolatedTimeoutMs,
)

test(
  "diagnostic: plain motion-target growth at the bottom",
  async () => {
    await page.goto(`${url}?scrolling&motion&content=long-history`)
    await page.evaluate(() => window.__conversationProcess.latest())
    await page.waitForFunction(() => {
      const viewport = document.querySelector<HTMLElement>("[data-scroller]")
      return (
        !!viewport &&
        viewport.scrollHeight > viewport.clientHeight &&
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 1
      )
    })
    await page.waitForFunction(
      () => document.querySelector<HTMLElement>("[data-scroller]")?.dataset.hydrated === "true",
    )
    await page.waitForFunction(() => !document.querySelector("[data-follow-motion]")?.getAnimations().length)

    await page.evaluate(() => {
      const calls: string[] = []
      const original = Element.prototype.animate
      Element.prototype.animate = function (this: Element, ...args: Parameters<Element["animate"]>) {
        const owner = this.getAttribute("data-follow-motion") !== null ? "conversation" : "other"
        calls.push(`${owner}:${JSON.stringify(args[0])}`)
        return original.apply(this, args)
      }
      const target = window as Window & { __motionCalls?: string[]; __restoreMotion?: () => void }
      target.__motionCalls = calls
      target.__restoreMotion = () => {
        Element.prototype.animate = original
        target.__restoreMotion = undefined
      }
      const motion = document.querySelector<HTMLElement>("[data-follow-motion]")!
      const spacer = document.createElement("div")
      spacer.style.height = "14px"
      spacer.dataset.diagnosticGrowth = "true"
      motion.append(spacer)
    })

    const samples = []
    for (let frame = 0; frame < 12; frame++) {
      await nextFrame()
      samples.push(
        await page.evaluate((phase) => {
          const viewport = document.querySelector<HTMLElement>("[data-scroller]")!
          const motion = document.querySelector<HTMLElement>("[data-follow-motion]")!
          return {
            phase,
            scrollTop: viewport.scrollTop,
            max: viewport.scrollHeight - viewport.clientHeight,
            gap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
            calls: (window as Window & { __motionCalls?: string[] }).__motionCalls ?? [],
            transform: getComputedStyle(motion).transform,
            animations: motion.getAnimations().map((animation) => animation.currentTime),
          }
        }, `plain-growth-${frame}`),
      )
    }
    expect(samples.some((sample) => sample.calls.some((call) => call.startsWith("conversation:")))).toBe(false)
    await page.evaluate(() => (window as Window & { __restoreMotion?: () => void }).__restoreMotion?.())
    expect(errors).toEqual([])
  },
  testOptions.isolatedTimeoutMs,
)
