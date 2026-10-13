import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { createRequire } from "node:module"
import { startPluginPreview, approvePreviewPlugins, openPluginPreviewPage } from "../../packages/plugin-kit/src/testing"
import { createFixtureProject, writeMinimalPlugin, minimalPluginSource } from "../../packages/plugin-kit/test/fixtures"
import { buildPluginProject } from "../../packages/plugin-kit/src/commands/build"
import { importPreviewConversation } from "./session-fixture"
import type { SessionTimelinePage } from "../../packages/sdk/js/src/client"

const require = createRequire(path.resolve(import.meta.dir, "../../apps/web/package.json"))
const { chromium } = await import(require.resolve("playwright"))

describe("production conversation history", () => {
  let project: ReturnType<typeof createFixtureProject> | undefined
  let preview: Awaited<ReturnType<typeof startPluginPreview>>
  let conversation: Awaited<ReturnType<typeof importPreviewConversation>>

  beforeAll(async () => {
    const started = performance.now()
    project = createFixtureProject("message-host")
    writeMinimalPlugin(project, minimalPluginSource("message-fixture"), "message-fixture")
    expect(await buildPluginProject(project.root)).toBe(true)
    preview = await startPluginPreview({
      artifacts: [path.join(project.root, "dist")],
      command: [process.execPath, path.resolve(import.meta.dir, "../../packages/presets/src/index.ts")],
    })
    await approvePreviewPlugins(preview)
    conversation = await importPreviewConversation(preview, { title: "History fixture", turns: 360 })
    console.info(`[conversation history] preparation: ${Math.round(performance.now() - started)}ms`)
  }, 90000)

  afterAll(async () => {
    try {
      await preview?.close()
    } finally {
      project?.cleanup()
    }
  }, 30000)

  test("native public conversation retains bounded history and reconciles updates after reconnect", async () => {
    const conversation = await importPreviewConversation(preview, { title: "Reconnect history fixture", turns: 360 })
    const started = performance.now()
    const phase = (name: string) =>
      console.info(`[conversation history] ${name}: ${Math.round(performance.now() - started)}ms`)
    const browser = await chromium.launch({ headless: true })
    let diagnostics: { errors: Error[]; dispose(): unknown } | undefined
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
      const page = await context.newPage()
      const cdp = await context.newCDPSession(page)
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 })
      page.setDefaultTimeout(20000)
      diagnostics = await openPluginPreviewPage(preview, page)
      await page.route("**/session/**/timeline**", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 200))
        await route.continue()
      })
      await page.route("**/session/**/message/**/part/**", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1800))
        await route.continue()
      })
      await page.goto(conversation.url)
      await page.getByText("Answer 360", { exact: true }).waitFor()
      phase("initial answer")
      const roots = page.locator('.session-conversation-content [data-display-row][data-message-role="user"]')
      // Body, process and footer rows share one turn identity.
      const rootCount = () =>
        roots.evaluateAll((rows) => new Set(rows.map((row) => row.getAttribute("data-turn-root"))).size)
      expect(await rootCount()).toBeGreaterThan(0)
      expect(await rootCount()).toBeLessThanOrEqual(30)
      await page.waitForFunction(() => {
        const scroller = document.querySelector(".session-conversation-content")?.closest(".overflow-y-auto")
        return scroller && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 10
      })
      await page.unroute("**/session/**/message/**/part/**")
      const readableViewport = page.locator(
        '[data-session-resident]:not([hidden]) [data-conversation-viewport][data-ready="true"]',
      )
      await readableViewport.hover({ position: { x: 30, y: 50 } })
      await page.mouse.wheel(0, -1000)
      let oldestTime = conversation.messages.at(-1)!.info.time.created
      for (let pageIndex = 0; pageIndex < 2; pageIndex++) {
        const [response] = await Promise.all([
          page.waitForResponse(async (response) => {
            const url = new URL(response.url())
            if (
              url.pathname !== `/session/${conversation.id}/timeline/page` ||
              !url.searchParams.has("cursor") ||
              url.searchParams.has("messageID") ||
              !response.ok()
            )
              return false
            const timeline = (await response.json()) as SessionTimelinePage
            const oldest = timeline.items.find((item) => item.info.role === "user")
            return !!oldest && oldest.info.time.created < oldestTime
          }),
          page.getByRole("button", { name: "Load earlier messages", exact: true }).click(),
        ])
        const text = await response.text()
        const timeline = JSON.parse(text) as SessionTimelinePage
        expect(response.ok()).toBe(true)
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(256 * 1024)
        expect(timeline.items.length).toBeLessThanOrEqual(100)
        const oldest = timeline.items.find((item) => item.info.role === "user")!
        expect(oldest.info.time.created).toBeLessThan(oldestTime)
        oldestTime = oldest.info.time.created
        const original = conversation.messages.find((item) => item.info.id === oldest.info.id)!
        const question = original.parts.find((part) => part.type === "text")!
        if (question.type !== "text") throw new Error("Historical question text missing")
        await page.getByRole("button", { name: "Load earlier messages", exact: true }).waitFor()
        await page.evaluate(async () => {
          for (let frame = 0; frame < 3; frame++)
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        })
        const viewport = await page
          .locator(".session-conversation-content")
          .evaluate((node) => node.closest(".overflow-y-auto")!.getBoundingClientRect().toJSON())
        await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2)
        await page.mouse.wheel(0, -100_000)
        await page.getByText(question.text, { exact: true }).waitFor()
        phase(`history page ${pageIndex + 1}`)
        expect(await rootCount()).toBeLessThanOrEqual(30)
        expect(await page.locator("[data-display-row]").count()).toBeLessThanOrEqual(80)
      }
      for (const { question, activation } of [137, 350].flatMap((question) =>
        ["click", "Enter", "Space"].map((activation) => ({ question, activation })),
      )) {
        await page.keyboard.press("ControlOrMeta+f")
        const historySearch = page.getByRole("dialog", { name: "Search conversation", exact: true })
        await historySearch.waitFor()
        await historySearch.getByPlaceholder("Search all conversation history").fill(`Question ${question}`)
        expect(await historySearch.getByLabel("Include reasoning", { exact: true }).count()).toBe(1)
        expect(await historySearch.getByLabel("Include tool content", { exact: true }).count()).toBe(1)
        await historySearch.getByRole("button", { name: `Question ${question}`, exact: true }).click()
        await historySearch.waitFor({ state: "detached" })
        await page.getByText(`Question ${question}`, { exact: true }).waitFor()
        phase(`search result ${question}`)
        expect(await rootCount()).toBeLessThanOrEqual(30)
        expect(await page.locator("[data-display-row]").count()).toBeLessThanOrEqual(80)
        const returnLatest = page.getByRole("button", { name: "Back to latest", exact: true })
        if (activation === "click") await returnLatest.click()
        else await returnLatest.press(activation)
        await page.getByText("Answer 360", { exact: true }).waitFor()
        await page.waitForFunction(() => {
          const scroller = document.querySelector("[data-conversation-viewport]")
          return scroller && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 10
        })
        await page.setViewportSize({ width: page.viewportSize()!.width === 1440 ? 1280 : 1440, height: 1000 })
        const distances = await page.evaluate(async () => {
          const distances: number[] = []
          for (let frame = 0; frame < 24; frame++) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
            const scroller = document.querySelector("[data-conversation-viewport]")!
            distances.push(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop)
          }
          return distances
        })
        expect(Math.max(...distances)).toBeLessThan(10)
        phase(`returned to latest with ${activation}`)
      }
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 })
      const { data } = await preview.client.session.messages(
        { scopeID: "home", sessionID: conversation.id },
        { throwOnError: true },
      )
      const latest = data?.find((item) => item.parts.some((part) => part.type === "text" && part.text === "Answer 360"))
      expect(data).toHaveLength(720)
      const part = latest?.parts.find((part) => part.type === "text")
      if (!latest || !part) throw new Error("Conversation fixture part missing")
      await context.setOffline(true)
      await new Promise((resolve) => setTimeout(resolve, 250))
      await preview.client.part.update(
        {
          scopeID: "home",
          sessionID: conversation.id,
          messageID: latest.info.id,
          partID: part.id,
          part: { ...part, type: "text", text: "Answer 360 recovered after reconnect" },
        },
        { throwOnError: true },
      )
      await context.setOffline(false)
      await page.getByText("Answer 360 recovered after reconnect", { exact: true }).waitFor()
      phase("reconnected")
      expect(await rootCount()).toBeLessThanOrEqual(30)
      await page.reload()
      await page.getByText("Answer 360 recovered after reconnect", { exact: true }).waitFor()
      phase("reloaded")
      expect(diagnostics.errors.map((error) => error.message)).toEqual([])
    } catch (error) {
      const page = browser.contexts()[0]?.pages()[0]
      if (page && !page.isClosed())
        console.info(
          "[conversation history] failure viewport:",
          await page
            .evaluate(() => {
              const viewport = document.querySelector<HTMLElement>("[data-conversation-viewport]")
              if (!viewport) return { mounted: false }
              const bounds = viewport.getBoundingClientRect()
              return {
                top: viewport.scrollTop,
                height: viewport.scrollHeight,
                client: viewport.clientHeight,
                rows: [...viewport.querySelectorAll<HTMLElement>('[data-display-row][data-message-role="user"]')]
                  .map((row) => ({
                    text: row.textContent?.slice(0, 80),
                    top: row.getBoundingClientRect().top - bounds.top,
                    height: row.getBoundingClientRect().height,
                  }))
                  .slice(0, 30),
              }
            })
            .catch((captureError) => ({ captureError: String(captureError) })),
        )
      throw new AggregateError([error, ...(diagnostics?.errors ?? [])], "Conversation real-host acceptance failed")
    } finally {
      diagnostics?.dispose()
      await browser.close()
    }
  }, 180000)

  test("paging inside a long completed turn never replaces its readable answer with transient load rows", async () => {
    const seed = await importPreviewConversation(preview, { title: "Dense history", turns: 1 })
    const { data: info } = await preview.client.session.get(
      { scopeID: "home", sessionID: seed.id },
      { throwOnError: true },
    )
    const root = seed.messages[0]
    const answer = seed.messages[1]
    const messages = [
      root,
      ...Array.from({ length: 240 }, (_, index) => {
        const id = `msg_dense_${String(index).padStart(6, "0")}`
        return {
          info: {
            ...answer.info,
            id,
            finish: index === 239 ? "stop" : "tool-calls",
            time: { created: Date.now() + index, completed: Date.now() + index + 1 },
          },
          parts: [
            {
              ...answer.parts[0],
              id: `prt_dense_${index}`,
              messageID: id,
              type: "text",
              text: index === 239 ? "Retained final answer." : `Progress step ${index}.`,
            },
          ],
        }
      }),
    ]
    const file = new File([JSON.stringify({ info, messages })], "dense.json", { type: "application/json" })
    const { data: imported } = await preview.client.session.import({ scopeID: "home", file }, { throwOnError: true })
    if (!imported) throw new Error("Dense conversation missing")
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage({ viewport: { width: 1100, height: 950 } })
      await openPluginPreviewPage(preview, page)
      await page.goto(new URL(`/aG9tZQ/session/${imported.rootSessionID}`, preview.url).href)
      await page.getByText("Retained final answer.", { exact: true }).waitFor()
      await page.waitForFunction(
        () => !document.querySelector("[data-markdown-pending]") && !document.getAnimations().length,
      )
      let bodyReads = 0
      page.on("request", (request) => {
        if (new URL(request.url()).pathname.endsWith("/content")) bodyReads++
      })
      let summaryReads = 0
      await page.route("**/session/**/part/pages", async (route) => {
        summaryReads++
        await new Promise((resolve) => setTimeout(resolve, 350))
        await route.continue()
      })
      const timelineResponse = page.waitForResponse((response) => {
        const url = new URL(response.url())
        return (
          url.pathname === `/session/${imported.rootSessionID}/timeline/page` &&
          url.searchParams.has("cursor") &&
          response.ok()
        )
      })
      const samples = await page.getByText("Retained final answer.", { exact: true }).evaluate(async (answer) => {
        const row = answer.closest<HTMLElement>("[data-display-row]")!
        const top = row.getBoundingClientRect().top
        const viewport = row.closest("[data-conversation-viewport]")!
        const button = [...document.querySelectorAll("button")].find(
          (button) => button.textContent === "Load earlier messages",
        )!
        button.click()
        const samples = []
        let settled = 0
        for (let frame = 0; frame < 600 && settled < 20; frame++) {
          await new Promise(requestAnimationFrame)
          settled = button.disabled ? 0 : settled + 1
          samples.push({
            connected: answer.isConnected,
            drift: row.getBoundingClientRect().top - top,
            loads: viewport.querySelectorAll('[data-row-kind="load"]').length,
            pending: button.disabled,
          })
        }
        return samples
      })
      const timeline = (await (await timelineResponse).json()) as SessionTimelinePage
      expect(timeline.items.length).toBeGreaterThan(0)
      expect(summaryReads).toBeGreaterThan(0)
      expect(samples.some((sample) => sample.pending)).toBe(true)
      expect(samples.at(-1)?.pending).toBe(false)
      expect(
        samples.every((sample) => sample.connected),
        JSON.stringify(samples),
      ).toBe(true)
      expect(Math.max(...samples.map((sample) => Math.abs(sample.drift)))).toBeLessThanOrEqual(1)
      expect(Math.max(...samples.map((sample) => sample.loads))).toBe(0)
      expect(bodyReads).toBe(0)
      await page.getByRole("button", { name: "Load earlier messages", exact: true }).waitFor()
    } finally {
      await browser.close()
    }
  }, 60000)

  test("cold navigation keeps the target shell operable through preparation and warms the original transcript", async () => {
    const target = await importPreviewConversation(preview, { title: "Cold navigation target", turns: 2 })
    const browser = await chromium.launch({ headless: true })
    const preparation = Promise.withResolvers<void>()
    const history = Promise.withResolvers<void>()
    const preparing = Promise.withResolvers<void>()
    const loading = Promise.withResolvers<void>()
    let diagnostics: { errors: Error[]; dispose(): unknown } | undefined
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
      page.setDefaultTimeout(20000)
      diagnostics = await openPluginPreviewPage(preview, page)
      await page.goto(conversation.url)
      const active = page.locator("[data-session-resident]:not([hidden])")
      await active.getByText("Answer 360", { exact: true }).waitFor()
      const original = await active.locator("[data-conversation-viewport]").elementHandle()
      await page.route(`**/global/storage/upgrade/sessions/${target.id}/prepare`, async (route) => {
        preparing.resolve()
        await preparation.promise
        await route.continue()
      })
      await page.route(`**/session/${target.id}/timeline/page*`, async (route) => {
        loading.resolve()
        await history.promise
        await route.continue()
      })
      const admission = page.evaluate(async (sessionID: string) => {
        const frames: Array<{ opacity: number; inert: boolean; introduction: boolean; text: string }> = []
        for (let index = 0; index < 600; index++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          const current = document.querySelector<HTMLElement>("[data-session-resident]:not([hidden])")
          if (!current?.dataset.sessionResident?.includes(sessionID)) continue
          const viewport = current.querySelector<HTMLElement>("[data-conversation-viewport]")
          frames.push({
            opacity: Number(getComputedStyle(current).opacity),
            inert: current.inert,
            introduction: !!current.querySelector("[data-session-new]"),
            text: current.textContent ?? "",
          })
          if (frames.at(-1)!.text.includes("Answer 2") && viewport?.dataset.ready === "true") break
        }
        return frames
      }, target.id)
      await page.getByRole("button", { name: "Cold navigation target", exact: true }).click()
      await preparing.promise
      expect(await active.getByText("Answer 360", { exact: true }).count()).toBe(0)
      expect(await page.locator("[data-conversation-retained]").count()).toBe(0)
      expect(await active.evaluate((el) => (el as HTMLElement).inert)).toBe(false)
      expect(await page.getByRole("textbox").first().isVisible()).toBe(true)
      preparation.resolve()
      await loading.promise
      history.resolve()
      const frames = await admission
      expect(frames.length).toBeGreaterThan(0)
      expect(frames.length).toBeLessThan(600)
      expect(frames.every((frame) => frame.opacity === 1 && !frame.inert && !frame.introduction)).toBe(true)
      expect(frames.at(-1)!.text).toContain("Answer 2")
      await page.getByRole("button", { name: "History fixture", exact: true }).click()
      await active.getByText("Answer 360", { exact: true }).waitFor()
      expect(
        await active.locator("[data-conversation-viewport]").evaluate((el, original) => el === original, original),
      ).toBe(true)
      expect(diagnostics.errors.map((error) => error.message)).toEqual([])
    } finally {
      preparation.resolve()
      history.resolve()
      diagnostics?.dispose()
      await browser.close()
    }
  }, 60000)

  test.each(["bodies", "execution"] as const)(
    "cold history waits for %s last, and warm returns preserve footer geometry",
    async (lastResponse) => {
      const paragraphs = Array.from(
        { length: 5 },
        (_, index) =>
          `Answer 24, paragraph ${index + 1}. ${"A large Markdown paragraph must retain every word while the session is being hydrated. ".repeat(90)}End of paragraph ${index + 1}.`,
      )
      const expectedText = paragraphs.join(" ")
      const targetTitle = `Delayed Markdown fixture ${lastResponse}`
      const target = await importPreviewConversation(preview, {
        title: targetTitle,
        turns: 24,
        answer: (turn) =>
          turn === 24
            ? paragraphs.map((text) => `**${text}**`).join("\n\n")
            : `## Answer ${turn}\n\nA paragraph with **emphasis** and \`code\`.`,
      })
      const messageID = target.messages.at(-1)!.info.id
      const browser = await chromium.launch({ headless: true })
      const bodies = Promise.withResolvers<void>()
      const bodyRequested = Promise.withResolvers<void>()
      const latestBodyDelivered = Promise.withResolvers<void>()
      const execution = Promise.withResolvers<void>()
      const executionRequested = Promise.withResolvers<void>()
      const executionDelivered = Promise.withResolvers<void>()
      const warmExecution = Promise.withResolvers<void>()
      let warming = false
      let bodyReads = 0
      let diagnostics: { errors: Error[]; dispose(): unknown } | undefined
      type Frame = {
        phase: "cold" | "last-held" | "released" | "warm"
        target: boolean
        resident: string | undefined
        shellOpacity: number
        inert: boolean
        visible: boolean
        ready: boolean
        opacity: number
        completeText: boolean
        textLength: number
        pending: boolean
        footerKey: string | undefined
        footerState: string | undefined
        geometry: number[] | undefined
        stationary: boolean
        sameViewport: boolean
      }
      type Probe = { frames: Frame[]; phase: Frame["phase"]; retainedViewport?: Element; stopped: boolean }
      try {
        const page = await browser.newPage({ viewport: { width: 960, height: 900 }, reducedMotion: "no-preference" })
        page.setDefaultTimeout(20000)
        diagnostics = await openPluginPreviewPage({ ...preview, url: conversation.url }, page)
        const active = page.locator("[data-session-resident]:not([hidden])")
        await active.getByText("Answer 360", { exact: true }).waitFor()
        await page.route(`**/session/${target.id}/message/**/part/**/content*`, async (route) => {
          bodyReads++
          const response = await route.fetch()
          bodyRequested.resolve()
          await bodies.promise
          await route.fulfill({ response })
          if (new URL(route.request().url()).pathname.includes(`/message/${messageID}/`)) latestBodyDelivered.resolve()
        })
        await page.route(`**/session/${target.id}/turn-execution*`, async (route) => {
          const gate = warming ? warmExecution : execution
          const response = await route.fetch()
          executionRequested.resolve()
          await gate.promise
          await route.fulfill({ response })
          if (!warming) executionDelivered.resolve()
        })
        await page.evaluate(
          ({ sessionID, rootID, messageID, expectedText }) => {
            const state: Probe = { frames: [], phase: "cold", stopped: false }
            Object.assign(window, { switchFrames: state })
            const presentation = (element: HTMLElement | null | undefined) => {
              let visible = !!element
              let opacity = 1
              for (let current = element; current; current = current.parentElement) {
                const style = getComputedStyle(current)
                opacity *= Number(style.opacity)
                visible &&=
                  style.display !== "none" && style.visibility === "visible" && style.contentVisibility !== "hidden"
              }
              return { visible: visible && opacity > 0, opacity }
            }
            const sample = () => {
              if (state.stopped) return
              const current = document.querySelector<HTMLElement>("[data-session-resident]:not([hidden])")
              const target = !!current?.dataset.sessionResident?.includes(sessionID)
              const viewport = target ? current?.querySelector<HTMLElement>("[data-conversation-viewport]") : undefined
              const footer = viewport?.querySelector<HTMLElement>(`[data-display-row="${rootID}:footer"]`)
              const motion = viewport?.querySelector<HTMLElement>("[data-conversation-motion]")
              const body = viewport?.querySelector<HTMLElement>(
                `[data-message-id="${messageID}"][data-row-kind="body"]`,
              )
              const text = [
                ...(body?.querySelectorAll('[data-component="text-part"] [data-component="markdown"]') ?? []),
              ]
                .map((element) => element.textContent ?? "")
                .join(" ")
                .replace(/\s+/g, " ")
                .trim()
              const shown = presentation(motion ?? viewport)
              const viewportBounds = viewport?.getBoundingClientRect()
              const footerBounds = footer?.getBoundingClientRect()
              const items = [
                motion,
                body,
                footer,
                ...(body?.querySelectorAll<HTMLElement>('[data-slot="session-turn-timeline-item"]') ?? []),
              ].filter((element): element is HTMLElement => !!element && presentation(element).visible)
              state.frames.push({
                phase: state.phase,
                target,
                resident: current?.dataset.sessionResident,
                shellOpacity: current ? Number(getComputedStyle(current).opacity) : 0,
                inert: current?.inert ?? true,
                visible: !!viewportBounds?.width && !!viewportBounds.height && shown.visible,
                ready: viewport?.dataset.ready === "true",
                opacity: Math.min(shown.opacity, ...items.map((element) => presentation(element).opacity)),
                completeText: text.endsWith("End of paragraph 5.") && expectedText.includes(text),
                textLength: text.length,
                pending:
                  !!viewport?.querySelector("[data-markdown-pending],[data-content-pending]") ||
                  document.fonts.status === "loading",
                footerKey: footer?.dataset.displayRow,
                footerState: footer
                  ? JSON.stringify({
                      text: footer.textContent,
                      controls: [...footer.querySelectorAll("button")].map((button) => ({
                        label: button.getAttribute("aria-label"),
                        disabled: button.disabled,
                        expanded: button.getAttribute("aria-expanded"),
                        copy: button.dataset.copyState,
                      })),
                    })
                  : undefined,
                geometry:
                  footerBounds && viewportBounds && viewport && motion && body
                    ? [
                        footerBounds.bottom - viewportBounds.bottom,
                        footerBounds.height,
                        footerBounds.width,
                        body.getBoundingClientRect().height,
                        motion.getBoundingClientRect().height,
                        viewport.scrollTop,
                        viewport.scrollHeight,
                        viewport.clientHeight,
                        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
                      ]
                    : undefined,
                stationary: items.every((element) => {
                  const transform = getComputedStyle(element).transform
                  return transform === "none" || new DOMMatrixReadOnly(transform).isIdentity
                }),
                sameViewport: viewport === state.retainedViewport,
              })
              requestAnimationFrame(sample)
            }
            sample()
          },
          { sessionID: target.id, rootID: target.messages.at(-2)!.info.id, messageID, expectedText },
        )
        await page.locator(`button[data-session-id="${target.id}"]:visible`).click()
        await page.waitForURL(target.url)
        await Promise.all([bodyRequested.promise, executionRequested.promise])
        await page.waitForFunction(() => {
          const { frames } = (window as unknown as { switchFrames: Probe }).switchFrames
          return frames.filter((frame) => frame.target && frame.phase === "cold").length >= 3
        })
        const composer = page.getByRole("textbox").first()
        expect(await composer.isEditable()).toBe(true)
        await composer.fill("Unsent retained draft")
        const held: Frame[] = await page.evaluate(
          () => (window as unknown as { switchFrames: Probe }).switchFrames.frames,
        )
        expect(
          held.filter((frame) => frame.target).every((frame) => !frame.visible && !frame.ready),
          JSON.stringify(held),
        ).toBe(true)
        if (lastResponse === "bodies") {
          execution.resolve()
          await executionDelivered.promise
        } else {
          bodies.resolve()
          await latestBodyDelivered.promise
        }
        await page.evaluate(() => {
          ;(window as unknown as { switchFrames: Probe }).switchFrames.phase = "last-held"
        })
        await page.waitForFunction(() => {
          const { frames } = (window as unknown as { switchFrames: Probe }).switchFrames
          return frames.filter((frame) => frame.target && frame.phase === "last-held").length >= 3
        })
        const pending: Frame[] = await page.evaluate(
          () => (window as unknown as { switchFrames: Probe }).switchFrames.frames,
        )
        expect(
          pending.filter((frame) => frame.target).every((frame) => !frame.visible && !frame.ready),
          JSON.stringify(pending.slice(-20)),
        ).toBe(true)
        await page.evaluate(() => {
          ;(window as unknown as { switchFrames: Probe }).switchFrames.phase = "released"
        })
        bodies.resolve()
        execution.resolve()
        await page.waitForFunction(() => {
          const { frames } = (window as unknown as { switchFrames: Probe }).switchFrames
          return frames.filter((frame) => frame.target && frame.visible).length >= 120
        })
        const cold: Frame[] = await page.evaluate(
          () => (window as unknown as { switchFrames: Probe }).switchFrames.frames,
        )
        expect(bodyReads).toBeGreaterThan(0)
        expect(cold.filter((frame) => frame.target).every((frame) => frame.shellOpacity === 1 && !frame.inert)).toBe(
          true,
        )
        const firstVisible = cold.findIndex((frame) => frame.target && frame.visible)
        expect(firstVisible).toBeGreaterThan(0)
        const visible = cold.slice(firstVisible)
        const baseline = visible.at(-1)!
        const assertStatic = (frames: Frame[], reference: Frame) => {
          expect(frames.length).toBeGreaterThanOrEqual(120)
          expect(
            frames.every(
              (frame) => frame.target && frame.visible && frame.ready && frame.completeText && !frame.pending,
            ),
            JSON.stringify(
              frames
                .filter((frame) => !frame.visible || !frame.ready || !frame.completeText || frame.pending)
                .slice(0, 20),
            ),
          ).toBe(true)
          expect(
            frames.every((frame) => frame.opacity === 1 && frame.stationary),
            JSON.stringify(frames.slice(0, 20)),
          ).toBe(true)
          expect(reference.geometry).toBeDefined()
          expect(
            frames.every(
              (frame) => frame.footerKey === reference.footerKey && frame.footerState === reference.footerState,
            ),
          ).toBe(true)
          for (const frame of frames) {
            expect(frame.geometry, JSON.stringify(frame)).toBeDefined()
            expect(
              Math.max(...frame.geometry!.map((value, index) => Math.abs(value - reference.geometry![index]))),
              JSON.stringify(frame),
            ).toBeLessThan(2)
            expect(Math.abs(frame.geometry!.at(-1)!)).toBeLessThan(2)
          }
        }
        assertStatic(visible, baseline)
        const viewport = await active.locator("[data-conversation-viewport]").elementHandle()
        await page.evaluate(() => {
          const state = (window as unknown as { switchFrames: Probe }).switchFrames
          state.retainedViewport = document.querySelector(
            "[data-session-resident]:not([hidden]) [data-conversation-viewport]",
          )!
        })
        warming = true
        await page.getByRole("button", { name: "History fixture", exact: true }).click()
        await active.getByText("Answer 360", { exact: true }).waitFor()
        await page.evaluate(() => {
          ;(window as unknown as { switchFrames: Probe }).switchFrames.phase = "warm"
        })
        await page.locator(`button[data-session-id="${target.id}"]:visible`).click()
        await page.waitForURL(target.url)
        await page.waitForFunction(() => {
          const { frames } = (window as unknown as { switchFrames: Probe }).switchFrames
          return frames.filter((frame) => frame.target && frame.phase === "warm").length >= 24
        })
        warmExecution.resolve()
        await page.waitForFunction(() => {
          const { frames } = (window as unknown as { switchFrames: Probe }).switchFrames
          return frames.filter((frame) => frame.target && frame.phase === "warm").length >= 144
        })
        const warm: Frame[] = await page.evaluate(() => {
          const state = (window as unknown as { switchFrames: Probe }).switchFrames
          state.stopped = true
          return state.frames.filter((frame) => frame.target && frame.phase === "warm")
        })
        assertStatic(warm, baseline)
        expect(warm.every((frame) => frame.sameViewport && frame.resident === baseline.resident)).toBe(true)
        expect(
          await active.locator("[data-conversation-viewport]").evaluate((el, saved) => el === saved, viewport),
        ).toBe(true)
        expect(await composer.innerText()).toBe("Unsent retained draft")
        expect(diagnostics.errors.map((error) => error.message)).toEqual([])
      } catch (error) {
        const page = browser.contexts()[0]?.pages()[0]
        if (page && !page.isClosed()) {
          console.info(
            "[conversation readiness failure]",
            JSON.stringify(
              await page.evaluate(() => ({
                frames: (window as unknown as { switchFrames?: Probe }).switchFrames?.frames.slice(-2),
                markdown: [
                  ...document.querySelectorAll(
                    '[data-session-resident]:not([hidden]) [data-component="text-part"] [data-component="markdown"]',
                  ),
                ].map((element) => ({
                  length: element.textContent?.length,
                  start: element.textContent?.slice(0, 120),
                  end: element.textContent?.slice(-180),
                  blocks: element.querySelectorAll("[data-markdown-block]").length,
                  html: element.outerHTML.slice(0, 350),
                })),
                pending: [
                  ...document.querySelectorAll(
                    "[data-session-resident]:not([hidden]) [data-content-pending], [data-session-resident]:not([hidden]) [data-markdown-pending]",
                  ),
                ].map((element) => element.outerHTML.slice(0, 1200)),
              })),
            ),
          )
        }
        throw error
      } finally {
        bodies.resolve()
        execution.resolve()
        warmExecution.resolve()
        diagnostics?.dispose()
        await browser.close()
      }
    },
    60000,
  )

  test("a new live Part after a warm switch retains its original arrival animation", async () => {
    const target = await importPreviewConversation(preview, { title: "Live arrival fixture" })
    const browser = await chromium.launch({ headless: true })
    let diagnostics: { errors: Error[]; dispose(): unknown } | undefined
    try {
      const page = await browser.newPage({ viewport: { width: 960, height: 900 }, reducedMotion: "no-preference" })
      page.setDefaultTimeout(20000)
      diagnostics = await openPluginPreviewPage({ ...preview, url: target.url }, page)
      const active = page.locator("[data-session-resident]:not([hidden])")
      await active.getByText("Answer 1", { exact: true }).waitFor()
      await page.waitForFunction(() => {
        const viewport = document.querySelector(
          '[data-session-resident]:not([hidden]) [data-conversation-viewport][data-ready="true"]',
        )
        return (
          viewport &&
          !viewport.querySelector("[data-markdown-pending]") &&
          !viewport.getAnimations({ subtree: true }).length
        )
      })
      const viewport = await active.locator("[data-conversation-viewport]").elementHandle()
      await page.getByRole("button", { name: "History fixture", exact: true }).click()
      await active.getByText("Answer 360", { exact: true }).waitFor()
      await page.getByRole("button", { name: "Live arrival fixture", exact: true }).click()
      await active.getByText("Answer 1", { exact: true }).waitFor()
      expect(await active.locator("[data-conversation-viewport]").evaluate((el, saved) => el === saved, viewport)).toBe(
        true,
      )
      const { data } = await preview.client.session.messages(
        { scopeID: "home", sessionID: target.id },
        { throwOnError: true },
      )
      const latest = data?.find((message) => message.info.role === "assistant")
      const original = latest?.parts.find((part) => part.type === "text")
      if (!latest || !original) throw new Error("Live arrival fixture Part missing")
      const partID = `${original.id}_live`
      const text = "A genuinely new Part arrived after returning to this retained session."
      type ArrivalFrame = {
        opacity: number
        transform: string
        height: number
        text: string
        originalOpacity: number
        keyframes: Array<{ opacity?: string | number; transform?: string | number; height?: string | number }>
      }
      type ArrivalProbe = { frames: ArrivalFrame[]; done: boolean }
      await page.evaluate(
        ({ messageID, originalID, partID }) => {
          const state: ArrivalProbe = { frames: [], done: false }
          Object.assign(window, { arrivalFrames: state })
          const sample = () => {
            const viewport = document.querySelector(
              "[data-session-resident]:not([hidden]) [data-conversation-viewport]",
            )
            const item = viewport?.querySelector<HTMLElement>(
              `[data-slot="session-turn-timeline-item"][data-scroll-anchor$=":${messageID}:${partID}"]`,
            )
            const original = viewport?.querySelector<HTMLElement>(
              `[data-slot="session-turn-timeline-item"][data-scroll-anchor$=":${messageID}:${originalID}"]`,
            )
            if (item) {
              const style = getComputedStyle(item)
              state.frames.push({
                opacity: Number(style.opacity),
                transform: style.transform,
                height: item.getBoundingClientRect().height,
                text: item.textContent ?? "",
                originalOpacity: original ? Number(getComputedStyle(original).opacity) : 0,
                keyframes: item.getAnimations().flatMap((animation) =>
                  animation.effect instanceof KeyframeEffect
                    ? animation.effect.getKeyframes().map((frame) => ({
                        opacity: frame.opacity,
                        transform: frame.transform,
                        height: frame.height,
                      }))
                    : [],
                ),
              })
            }
            if (state.frames.length < 60) requestAnimationFrame(sample)
            else state.done = true
          }
          requestAnimationFrame(sample)
        },
        { messageID: latest.info.id, originalID: original.id, partID },
      )
      await preview.client.part.update(
        {
          scopeID: "home",
          sessionID: target.id,
          messageID: latest.info.id,
          partID,
          part: { id: partID, sessionID: target.id, messageID: latest.info.id, type: "text", text },
        },
        { throwOnError: true },
      )
      await page.waitForFunction(() => (window as unknown as { arrivalFrames: ArrivalProbe }).arrivalFrames.done)
      const frames: ArrivalFrame[] = await page.evaluate(
        () => (window as unknown as { arrivalFrames: ArrivalProbe }).arrivalFrames.frames,
      )
      expect(
        frames.some((frame) => frame.opacity > 0 && frame.opacity < 1),
        JSON.stringify(frames.slice(0, 3)),
      ).toBe(true)
      const arrival = frames.find((frame) => frame.keyframes.length > 0)
      expect(arrival).toBeDefined()
      expect(arrival!.keyframes.map((frame) => Number(frame.opacity))).toEqual([0.65, 1])
      expect(arrival!.keyframes.every((frame) => frame.height === undefined && frame.transform === undefined)).toBe(
        true,
      )
      expect(frames.every((frame) => frame.originalOpacity === 1)).toBe(true)
      expect(
        frames.every((frame) => frame.transform === "none" || frame.transform === "matrix(1, 0, 0, 1, 0, 0)"),
      ).toBe(true)
      const completed = frames.at(-1)!
      expect(completed.opacity).toBe(1)
      expect(completed.text.trim()).toBe(text)
      const rendered = frames.filter((frame) => frame.text.trim() === text)
      expect(rendered.length).toBeGreaterThan(0)
      expect(
        Math.max(...rendered.map((frame) => frame.height)) - Math.min(...rendered.map((frame) => frame.height)),
      ).toBeLessThan(2)
      expect(diagnostics.errors.map((error) => error.message)).toEqual([])
    } finally {
      diagnostics?.dispose()
      await browser.close()
    }
  }, 60000)

  test("an existing Home session never becomes a new-task greeting while history is pending", async () => {
    const browser = await chromium.launch({ headless: true })
    let release = () => {}
    let diagnostics: { errors: Error[]; dispose(): unknown } | undefined
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(20000)
      diagnostics = await openPluginPreviewPage(preview, page)
      const pending = new Promise<void>((resolve) => {
        release = resolve
      })
      const requested = Promise.withResolvers<void>()
      await page.route(`**/session/${conversation.id}/timeline/page*`, async (route) => {
        requested.resolve()
        await pending
        await route.continue()
      })
      await page.goto(new URL("/aG9tZQ/session", preview.url).href)
      await page.getByRole("heading", { name: "Bring your ideas to life.", exact: true }).waitFor()
      await page.getByRole("button", { name: "History fixture", exact: true }).click()
      await page.waitForURL(`**/session/${conversation.id}`)
      await requested.promise
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      )
      expect(await page.locator(".session-empty-view:visible").count()).toBe(0)
      expect(await page.getByRole("heading", { name: "Bring your ideas to life.", exact: true }).count()).toBe(0)
      expect(await page.getByRole("heading", { name: "What would you like to work on?", exact: true }).count()).toBe(0)
      release()
      await page.getByText("Answer 360", { exact: true }).waitFor()
      const empty = (
        await preview.client.session.create(
          { scopeID: "home", title: "Empty existing session" },
          { throwOnError: true },
        )
      ).data!
      await page.getByRole("button", { name: "Empty existing session", exact: true }).click()
      await page.waitForURL(`**/session/${empty.id}`)
      await page.getByText("No messages yet", { exact: true }).waitFor()
      expect(await page.locator(".session-empty-view:visible").count()).toBe(0)
      expect(await page.getByRole("heading", { name: "Bring your ideas to life.", exact: true }).count()).toBe(0)
      expect(diagnostics.errors.map((error) => error.message)).toEqual([])
    } finally {
      release()
      diagnostics?.dispose()
      await browser.close()
    }
  }, 60000)
})

test("conversation display and notification preferences survive a production-host reload", async () => {
  const project = createFixtureProject("message-settings-host")
  let preview: Awaited<ReturnType<typeof startPluginPreview>> | undefined
  const browser = await chromium.launch({ headless: true })
  let diagnostics: { errors: Error[]; dispose(): unknown } | undefined
  try {
    writeMinimalPlugin(project, minimalPluginSource("message-fixture"), "message-fixture")
    expect(await buildPluginProject(project.root)).toBe(true)
    preview = await startPluginPreview({
      artifacts: [path.join(project.root, "dist")],
      command: [process.execPath, path.resolve(import.meta.dir, "../../packages/presets/src/index.ts")],
    })
    await approvePreviewPlugins(preview)
    const conversation = await importPreviewConversation(preview, { title: "Settings fixture" })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const page = await context.newPage()
    page.setDefaultTimeout(20000)
    diagnostics = await openPluginPreviewPage(preview, page)
    await page.goto(conversation.url)
    await page.getByText("Answer 1", { exact: true }).waitFor()
    async function settings() {
      await page.locator(".sidebar-account-trigger").click()
      await page.getByRole("menuitem", { name: "Settings", exact: true }).click()
      const dialog = page.getByRole("dialog", { name: "Settings", exact: true })
      await dialog.waitFor()
      await dialog.getByRole("button", { name: "General", exact: true }).click()
      return dialog
    }
    let dialog = await settings()
    for (const choice of ["Full", "Balanced", "Minimal"])
      expect(await dialog.getByRole("button", { name: choice, exact: true }).count()).toBe(1)
    await dialog.getByRole("button", { name: "Minimal", exact: true }).click()
    expect(await dialog.getByRole("button", { name: "Minimal", exact: true }).getAttribute("aria-pressed")).toBe("true")
    const workspace = dialog.getByRole("group", { name: "New task starting point", exact: true })
    await workspace.getByRole("button", { name: "Worktree", exact: true }).click()
    expect(await workspace.getByRole("button", { name: "Worktree", exact: true }).getAttribute("aria-pressed")).toBe(
      "true",
    )
    await dialog.getByRole("tab", { name: "Notifications", exact: true }).click()
    await dialog.getByText("In-app notification details", { exact: true }).click()
    const mute = dialog.getByLabel("Mute Info", { exact: true })
    const muted = await mute.isChecked()
    await dialog
      .locator('[data-component="switch"]')
      .filter({ has: page.getByLabel("Mute Info", { exact: true }) })
      .locator('[data-slot="switch-control"]')
      .click()
    expect(await mute.isChecked()).toBe(!muted)
    expect(await dialog.getByRole("slider", { name: "Interface zoom", exact: true }).count()).toBe(0)
    await dialog.getByRole("button", { name: "Save Changes", exact: true }).click()
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    await page.reload()
    await page.getByText("Answer 1", { exact: true }).waitFor()
    dialog = await settings()
    expect(await dialog.getByRole("button", { name: "Minimal", exact: true }).getAttribute("aria-pressed")).toBe("true")
    expect(
      await dialog
        .getByRole("group", { name: "New task starting point", exact: true })
        .getByRole("button", { name: "Worktree", exact: true })
        .getAttribute("aria-pressed"),
    ).toBe("true")
    await dialog.getByRole("tab", { name: "Notifications", exact: true }).click()
    await dialog.getByText("In-app notification details", { exact: true }).click()
    expect(await dialog.getByLabel("Mute Info", { exact: true }).isChecked()).toBe(!muted)
    expect(diagnostics.errors.map((error) => error.message)).toEqual([])
  } catch (error) {
    throw new AggregateError([error, ...(diagnostics?.errors ?? [])], "Settings real-host acceptance failed")
  } finally {
    diagnostics?.dispose()
    await browser.close()
    await preview?.close()
    project.cleanup()
  }
}, 90000)
