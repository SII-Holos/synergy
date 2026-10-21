import assert from "node:assert/strict"
import { mkdir, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { chromium } from "playwright"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"

const [home, origin, output] = process.argv.slice(2)
assert.ok(home && origin && output, "Usage: verify-background-return.ts <isolated-home> <origin> <output>")
const url = new URL(origin)
assert.equal(url.hostname, "127.0.0.1")
const client = createSynergyClient({ baseUrl: url.origin })
const options = { throwOnError: true } as const
assert.notEqual(await realpath(home), await realpath(homedir()))
assert.equal(await realpath((await client.path.get({ scopeID: "home" }, options)).data.home), await realpath(home))
await mkdir(output, { recursive: true })
const initial = Array.from(
  { length: 18 },
  (_, i) =>
    `### Reading section ${i}\n\nStable paragraph ${i}. ${"Previously accepted content remains readable. ".repeat(16)}\n\n`,
).join("")
const addition =
  "\n\n### Background result\n\n" + "Additional background evidence. ".repeat(70) + "\n\nFinal background marker."
const streams = new Map<string, { append(text: string): void; finish(): void }>()
const inference = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const input = (await request.json()) as {
      model: string
      stream?: boolean
      messages?: { role: string; content: unknown }[]
    }
    const key = JSON.stringify(input.messages ?? []).match(/background-return-([\w-]+)/)?.[1]
    if (input.model === "background-aux" || !key) {
      const message = { role: "assistant", content: "Background return acceptance" }
      if (input.stream)
        return new Response(
          [
            { choices: [{ index: 0, delta: message, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ]
            .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
            .join("") + "data: [DONE]\n\n",
          { headers: { "Content-Type": "text/event-stream" } },
        )
      return Response.json({
        id: "aux",
        object: "chat.completion",
        choices: [{ index: 0, message, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    }
    return new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()
          const send = (delta: object, finish_reason: string | null = null) =>
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ id: key, object: "chat.completion.chunk", created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
              ),
            )
          send({ role: "assistant", content: initial })
          streams.set(key, {
            append(text) {
              send({ content: text })
            },
            finish() {
              send({}, "stop")
              controller.enqueue(encoder.encode("data: [DONE]\n\n"))
              controller.close()
              streams.delete(key)
            },
          })
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    )
  },
})
await client.config.domain.update(
  {
    domain: "providers",
    configDomainUpdateInput: {
      config: {
        enabled_providers: ["background", "deepseek"],
        provider: {
          background: {
            name: "Background return fixture",
            npm: "@ai-sdk/openai-compatible",
            env: [],
            options: { baseURL: `${inference.url.origin}/v1`, apiKey: "fixture-only" },
            models: Object.fromEntries(
              ["background-chat", "background-aux"].map((id) => [
                id,
                { name: id, tool_call: true, limit: { context: 128000, output: 16384 } },
              ]),
            ),
          },
        },
      },
    },
  },
  options,
)
await client.config.domain.update(
  {
    domain: "models",
    configDomainUpdateInput: {
      config: {
        model: "background/background-chat",
        nano_model: "background/background-aux",
        mini_model: "background/background-aux",
        mid_model: "background/background-aux",
      },
    },
  },
  options,
)
const wait = async (predicate: () => boolean | Promise<boolean>) => {
  const until = Date.now() + 60_000
  while (!(await predicate())) {
    if (Date.now() > until) throw Error("Acceptance condition timed out")
    await Bun.sleep(50)
  }
}
type Sample = { offset: number; gap: number; anchor?: number; retained: boolean; visible: boolean; rows: number }
const results: object[] = []
const owned: string[] = []
const browser = await chromium.launch({ headless: true })
try {
  const peer = (await client.session.create({ scopeID: "home", title: "Return acceptance A" }, options)).data
  for (const ended of [false, true])
    for (const reading of [false, true]) {
      const key = `${ended ? "ended" : "running"}-${reading ? "reading" : "following"}-${Date.now()}`
      const session = (await client.session.create({ scopeID: "home", title: `Return acceptance ${key}` }, options))
        .data
      owned.push(session.id)
      console.log(JSON.stringify({ stage: "created", ended, reading }))
      const context = await browser.newContext({
        viewport: { width: 1280, height: 920 },
        colorScheme: ended ? "dark" : "light",
      })
      const page = await context.newPage()
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      const reads = new Map<string, number>()
      const traffic = { frames: 0, bytes: 0, contentBytes: 0, contentKinds: {} as Record<string, number> }
      page.on("request", (request) => {
        if (request.url().includes("/content") && request.url().includes(`/session/${session.id}/`))
          reads.set(request.url(), (reads.get(request.url()) ?? 0) + 1)
      })
      page.on("websocket", (ws) =>
        ws.on("framereceived", ({ payload }) => {
          traffic.frames++
          traffic.bytes += typeof payload === "string" ? Buffer.byteLength(payload) : payload.length
          const event = JSON.parse(String(payload)).payload
          if (event?.properties?.summary?.sessionID === session.id && event.properties.content) {
            const bytes = Buffer.byteLength(JSON.stringify(event.properties.content))
            traffic.contentBytes += bytes
            const kind = String(event.properties.content.kind)
            traffic.contentKinds[kind] = (traffic.contentKinds[kind] ?? 0) + bytes
          }
        }),
      )
      await page.addInitScript((sessionID) => {
        const state = window as unknown as { backgroundInterestReleased: boolean; interestGeneration: number }
        const send = WebSocket.prototype.send
        WebSocket.prototype.send = function (data) {
          send.call(this, data)
          if (typeof data !== "string") return
          const payload = JSON.parse(data).payload as {
            type: string
            properties: { generation: number; parts: { sessionID: string }[]; active?: { sessionID: string } }
          }
          if (payload?.type !== "client.view.interests" && payload?.type !== "client.content.interests") return
          const generation = payload.properties.generation
          state.interestGeneration = generation
          state.backgroundInterestReleased = false
          if (
            payload.properties.active?.sessionID === sessionID ||
            payload.properties.parts.some((part) => part.sessionID === sessionID)
          )
            return
          const acknowledged = (event: MessageEvent) => {
            if (typeof event.data !== "string" || JSON.parse(event.data).payload?.type !== "server.pong") return
            this.removeEventListener("message", acknowledged)
            if (state.interestGeneration === generation) state.backgroundInterestReleased = true
          }
          this.addEventListener("message", acknowledged)
          send.call(this, JSON.stringify({ payload: { type: "client.ping" } }))
        }
      }, session.id)
      const route = `${url.origin}/aG9tZQ/session/`
      await page.goto(route + session.id)
      await client.session.promptAsync(
        {
          scopeID: "home",
          sessionID: session.id,
          agent: "pico",
          model: { providerID: "background", modelID: "background-chat" },
          parts: [{ type: "text", text: `background-return-${key}` }],
        },
        options,
      )
      await wait(() => streams.has(key))
      console.log(JSON.stringify({ stage: "streaming", ended, reading }))
      const viewport = page.locator("[data-session-resident]:not([hidden]) [data-conversation-viewport]")
      await viewport.waitFor()
      await page.getByText("Reading section 17", { exact: true }).waitFor()
      await page.waitForFunction(
        () => !document.querySelector("[data-session-resident]:not([hidden]) [data-markdown-pending]"),
      )
      await page.waitForTimeout(300)
      if (reading) {
        await viewport.evaluate((element) => {
          element.dispatchEvent(new WheelEvent("wheel", { deltaY: -400 }))
          element.scrollTop = element.scrollHeight * 0.4
          element.dispatchEvent(new Event("scroll"))
        })
        await page.waitForTimeout(200)
      }
      await viewport.evaluate((element) => {
        const top = element.getBoundingClientRect().top
        const anchor = [...element.querySelectorAll<HTMLElement>("p")].find(
          (el) =>
            el.getBoundingClientRect().top >= top && el.getBoundingClientRect().bottom < top + element.clientHeight,
        )
        Object.assign(window, {
          returnOwner: element,
          returnAnchor: anchor,
          returnTop: anchor?.getBoundingClientRect().top,
          returnSamples: [],
          returnSampling: false,
        })
      })
      const before = Object.fromEntries(reads)
      await page.getByText(peer.title, { exact: true }).first().click()
      await page.waitForURL(route + peer.id)
      await page.waitForFunction(
        () => (window as unknown as { backgroundInterestReleased: boolean }).backgroundInterestReleased,
      )
      const hiddenTraffic = { ...traffic, contentKinds: { ...traffic.contentKinds } }
      const hiddenReads = Object.fromEntries(reads)
      streams.get(key)!.append(addition)
      if (ended) {
        streams.get(key)!.finish()
        await wait(async () => (await client.session.statuses(options)).data[session.id]?.type !== "busy")
        const messages = (await client.session.messages({ scopeID: "home", sessionID: session.id }, options)).data
        const assistants = messages.filter((message) => message.info.role === "assistant")
        assert.ok(
          assistants.length > 0 &&
            assistants.every((message) => message.info.role === "assistant" && !message.info.error),
        )
        assert.ok(assistants.some((message) => message.info.role === "assistant" && message.info.finish === "stop"))
      }
      await page.waitForTimeout(400)
      const afterHidden = Object.fromEntries(reads)
      const backgroundTraffic = {
        frames: traffic.frames - hiddenTraffic.frames,
        bytes: traffic.bytes - hiddenTraffic.bytes,
        contentBytes: traffic.contentBytes - hiddenTraffic.contentBytes,
        contentKinds: Object.fromEntries(
          Object.entries(traffic.contentKinds).map(([kind, bytes]) => [
            kind,
            bytes - (hiddenTraffic.contentKinds[kind] ?? 0),
          ]),
        ),
      }
      const cdp = await context.newCDPSession(page)
      let image = 0
      cdp.on("Page.screencastFrame", async ({ data, sessionId }) => {
        await Bun.write(
          path.join(output, `${key}-${String(image++).padStart(3, "0")}.jpg`),
          Buffer.from(data, "base64"),
        )
        await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {})
      })
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, everyNthFrame: 1 })
      await page.evaluate(() => {
        const state = window as unknown as {
          returnOwner: HTMLElement
          returnAnchor?: HTMLElement
          returnTop?: number
          returnSamples: Sample[]
          returnSampling: boolean
        }
        state.returnSampling = true
        const sample = () => {
          if (!state.returnSampling) return
          const viewport = state.returnOwner
          if (viewport.checkVisibility()) {
            const surface = viewport.querySelector<HTMLElement>("[data-conversation-motion]")!
            const transform = getComputedStyle(surface).transform
            state.returnSamples.push({
              offset: transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m42,
              gap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
              anchor:
                state.returnAnchor && state.returnTop !== undefined
                  ? state.returnAnchor.getBoundingClientRect().top - state.returnTop
                  : undefined,
              retained: !state.returnAnchor || state.returnAnchor.isConnected,
              visible: getComputedStyle(surface).opacity === "1" && viewport.getAttribute("aria-hidden") !== "true",
              rows: viewport.querySelectorAll("[data-display-row]").length,
            })
          }
          requestAnimationFrame(() => setTimeout(sample, 0))
        }
        requestAnimationFrame(sample)
      })
      await page.getByText(session.title, { exact: true }).first().click()
      await page.waitForURL(route + session.id)
      await page.waitForTimeout(1500)
      const samples = await page.evaluate(() => {
        const state = window as unknown as { returnSamples: Sample[]; returnSampling: boolean }
        state.returnSampling = false
        return state.returnSamples
      })
      await cdp.send("Page.stopScreencast")
      const maxOffset = Math.max(...samples.map((s) => Math.abs(s.offset)))
      const maxDrift = Math.max(...samples.map((s) => Math.abs(s.anchor ?? 0)))
      const maxGap = Math.max(...samples.map((s) => Math.abs(s.gap)))
      const answerVisible = (await viewport.textContent())?.includes("Final background marker") === true
      const unchangedRereads = [...reads].filter(
        ([request, count]) => before[request] !== undefined && count > before[request],
      )
      const passed =
        samples.length > 10 &&
        samples.every((s) => s.visible && s.rows > 0) &&
        maxOffset <= 1 &&
        answerVisible &&
        (reading || maxGap <= 2) &&
        (!reading || (maxDrift <= 1 && samples.every((s) => s.retained))) &&
        JSON.stringify(hiddenReads) === JSON.stringify(afterHidden) &&
        backgroundTraffic.contentBytes === 0 &&
        unchangedRereads.length === 0 &&
        errors.length === 0
      const result = {
        ended,
        reading,
        passed,
        frames: samples.length,
        images: image,
        maxOffset,
        maxDrift,
        maxGap,
        answerVisible,
        unchangedRereads: unchangedRereads.length,
        hiddenBodyReads: Object.keys(afterHidden).length - Object.keys(hiddenReads).length,
        backgroundTraffic,
        errors,
      }
      results.push(result)
      await Bun.write(path.join(output, `${key}.json`), JSON.stringify(samples))
      console.log(JSON.stringify(result))
      if (streams.has(key)) streams.get(key)!.finish()
      await context.close()
    }
} finally {
  for (const sessionID of owned) await client.session.abort({ scopeID: "home", sessionID }, options).catch(() => {})
  await browser.close()
  inference.stop(true)
  await Bun.write(path.join(output, "summary.json"), JSON.stringify(results, null, 2))
}
assert.ok(
  results.length === 4 && results.every((result) => (result as { passed: boolean }).passed),
  "Background return acceptance failed; inspect frame journals",
)
