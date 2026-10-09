import { afterEach, expect, test } from "bun:test"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { setupI18n } from "@lingui/core"
import { createComponent, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { createSynergyClient, type ExecutionContextSnapshot } from "@ericsanchezok/synergy-sdk/client"

await plugin({
  name: "context-interaction-render",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => ({
      contents: (await transformAsync(await Bun.file(path).text(), {
        filename: path,
        presets: [
          [import.meta.resolve("babel-preset-solid"), { generate: "dom" }],
          [import.meta.resolve("@babel/preset-typescript"), { isTSX: true, allExtensions: true }],
        ],
      }))!.code!,
      loader: "js",
    }))
    build.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }))
  },
})
const { I18nProvider } = await import("@lingui/solid")
const { ContextItemContent, ContextSourceItem } = await import("../../../src/components/execution/context-item-content")
const { ContextComposition } = await import("../../../src/components/execution/context-composition")
const { ContextHistoryChart } = await import("../../../src/components/execution/context-chart")
const i18n = setupI18n({ locale: "en", messages: { en: {} } })
const snapshot = (number: number, tokens: number | null): ExecutionContextSnapshot => ({
  sessionID: "session",
  callID: String(number),
  nodeID: String(number),
  runID: "round",
  requestNumber: number,
  roundNumber: 1,
  started: number,
  status: "completed",
  modelID: "model",
  providerID: "provider",
  inputTokens: tokens,
  outputTokens: 5,
  cacheHit: 0.5,
  contextLimit: 1000,
  elapsedMs: 2000,
  retries: 0,
  usage:
    tokens == null
      ? null
      : {
          version: 2,
          modelID: "model",
          providerID: "provider",
          totalInput: tokens,
          categories: [
            {
              category: "userMessages",
              precision: "source",
              estimatedTokens: tokens,
              attributedTokens: tokens,
              items: 1,
            },
          ],
          overhead: { attributedTokens: 0 },
          capturedAt: number,
          estimator: { kind: "bounded-utf8", sampledCharacters: 4, truncated: false },
          reconciliation: { mode: "residual", factor: 1 },
        },
  compactedBefore: false,
  requestAvailable: true,
})
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  document.body.replaceChildren()
})
const mount = (children: () => ReturnType<typeof ContextComposition>) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(
    render(
      () =>
        createComponent(I18nProvider, {
          i18n,
          get children() {
            return children()
          },
        }),
      host,
    ),
  )
  return host
}
test("chart preview never selects a request and updates preserve keyboard focus", () => {
  const [items, setItems] = createSignal([snapshot(2, 30), snapshot(1, 20)])
  const [selected, setSelected] = createSignal("1")
  const host = mount(() =>
    createComponent(ContextHistoryChart, {
      get items() {
        return items()
      },
      get selected() {
        return selected()
      },
      onSelect: setSelected,
      grouping: "request",
      onGrouping: () => {},
      delta: false,
      onDelta: () => {},
    }),
  )
  const buttons = host.querySelectorAll<HTMLButtonElement>(".context-history-bar")
  buttons[1].dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }))
  expect(selected()).toBe("1")
  buttons[0].focus()
  setItems([snapshot(3, 40), snapshot(2, 32), snapshot(1, 20)])
  expect(document.activeElement).toBe(buttons[0])
  expect(host.querySelectorAll(".context-history-bar")[0]).toBe(buttons[0])
  buttons[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
  expect(document.activeElement).toBe(host.querySelectorAll(".context-history-bar")[1])
  expect(selected()).toBe("1")
  host.querySelectorAll<HTMLButtonElement>(".context-history-bar")[2].click()
  expect(selected()).toBe("3")
})

test("switching and previewing requests never changes other historical segments", () => {
  const values = [snapshot(1, 10), snapshot(2, 20), snapshot(3, 30)]
  const [selected, setSelected] = createSignal("1")
  const [preview, setPreview] = createSignal("")
  const host = mount(() =>
    createComponent(ContextHistoryChart, {
      items: values,
      get selected() {
        return selected()
      },
      get selectedSnapshot() {
        return values.find((entry) => entry.callID === selected())
      },
      onSelect: setSelected,
      onPreview: setPreview,
      grouping: "request",
      onGrouping: () => {},
      delta: false,
      onDelta: () => {},
    }),
  )
  const bars = [...host.querySelectorAll<HTMLButtonElement>(".context-history-bar")]
  const segments = bars.map((bar) => bar.querySelector(".context-bar-positive > span")!)
  const styles = segments.map((segment) => segment.getAttribute("style"))
  for (const index of [2, 0, 1, 2, 1]) {
    bars[index].dispatchEvent(new MouseEvent("mouseenter"))
    expect(preview()).toBe(String(index + 1))
    bars[index].click()
    expect(selected()).toBe(String(index + 1))
    expect(bars.map((bar) => bar.querySelector(".context-bar-positive > span"))).toEqual(segments)
    expect(segments.map((segment) => segment.getAttribute("style"))).toEqual(styles)
  }
  host.querySelector(".context-chart-bars")!.dispatchEvent(new MouseEvent("mouseleave"))
  expect(preview()).toBe("")
  expect(selected()).toBe("2")
})
test("composition distinguishes unknown data from known zero and labels historical capacity", () => {
  const [value, setValue] = createSignal(snapshot(1, null))
  const host = mount(() =>
    createComponent(ContextComposition, {
      get snapshot() {
        return value()
      },
      category: "",
      onCategory: () => {},
    }),
  )
  expect(host.textContent).toContain("Current context")
  expect(host.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBeNull()
  expect(host.textContent).toContain("not recorded")
  setValue(snapshot(1, 0))
  expect(host.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBe("0")
  expect(host.textContent).not.toContain("not recorded")
  setValue(snapshot(1, 100))
  expect(host.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBe("10")
  expect(host.querySelector(".context-capacity-track > span")?.getAttribute("style")).toContain("10%")
})

test("category hover highlights the composition temporarily without changing the selected source", () => {
  const [highlight, setHighlight] = createSignal("")
  const selected: string[] = []
  const host = mount(() =>
    createComponent(ContextComposition, {
      snapshot: snapshot(1, 100),
      category: "skills",
      get highlight() {
        return highlight()
      },
      onHighlight: setHighlight,
      onCategory: (value) => selected.push(value),
    }),
  )
  const row = host.querySelector<HTMLButtonElement>(".context-legend-row")!
  row.dispatchEvent(new MouseEvent("mouseenter"))
  expect(highlight()).toBe("userMessages")
  expect(row.getAttribute("data-highlighted")).toBe("true")
  expect(selected).toEqual([])
  row.dispatchEvent(new MouseEvent("mouseleave"))
  expect(highlight()).toBe("")
  row.focus()
  expect(highlight()).toBe("userMessages")
  row.click()
  expect(selected).toEqual(["userMessages"])
})

test("reopening a content reader ignores an aborted reply even after a new read starts", async () => {
  const pending: { request: Request; resolve: (response: Response) => void }[] = []
  const client = createSynergyClient({
    baseUrl: "http://fixture.test",
    fetch: Object.assign(
      (request: RequestInfo | URL) =>
        new Promise<Response>((resolve) => pending.push({ request: request as Request, resolve })),
      { preconnect: fetch.preconnect },
    ),
  })
  const [active, setActive] = createSignal(true)
  const host = mount(() =>
    createComponent(ContextItemContent, {
      client,
      sessionID: "session",
      snapshot: snapshot(1, 100),
      version: "one",
      item: {
        id: "item",
        category: "userMessages",
        path: ["messages", "0"],
        source: "message",
        characters: 7,
        precision: "source",
        offset: 0,
        bytes: 7,
      },
      get active() {
        return active()
      },
    }),
  )
  await Bun.sleep(0)
  setActive(false)
  setActive(true)
  await Bun.sleep(0)
  expect(pending).toHaveLength(2)
  expect(pending[0].request.signal.aborted).toBe(true)
  pending[0].resolve(Response.json({ text: '"stale"', nextOffset: null }))
  await Bun.sleep(0)
  expect(host.textContent).not.toContain("stale")
  expect(host.querySelector('[role="status"]')).not.toBeNull()
  pending[1].resolve(Response.json({ text: '"fresh"', nextOffset: null }))
  await Bun.sleep(0)
  expect(host.textContent).toContain("fresh")
  expect(host.textContent).not.toContain("stale")
})
test("round grouping keeps the selected request details instead of previewing another request", () => {
  const old = snapshot(1, 20)
  const host = mount(() =>
    createComponent(ContextHistoryChart, {
      items: [snapshot(2, 30), old],
      selected: "1",
      selectedSnapshot: old,
      onSelect: () => {},
      grouping: "round",
      onGrouping: () => {},
      delta: false,
      onDelta: () => {},
    }),
  )
  expect(host.querySelector(".context-request-heading")?.textContent).toContain("Request 1")
  expect(host.querySelector(".context-request-metrics")?.textContent).toContain("20")
})

test("source rows expose one explicit reading action and only load the selected body", async () => {
  let reads = 0
  const client = createSynergyClient({
    baseUrl: "http://fixture.test",
    fetch: Object.assign(
      async () => {
        reads++
        return Response.json({ text: '\"Instructions\"', nextOffset: null })
      },
      { preconnect: fetch.preconnect },
    ),
  })
  const [open, setOpen] = createSignal(false)
  const host = mount(() =>
    createComponent(ContextSourceItem, {
      client,
      sessionID: "session",
      snapshot: snapshot(1, 100),
      version: "one",
      item: {
        id: "item",
        category: "systemInstructions",
        path: ["system", "0"],
        source: "system",
        characters: 12,
        precision: "source",
        offset: 0,
        bytes: 14,
      },
      title: "System instructions 1",
      active: true,
      get open() {
        return open()
      },
      onToggle: () => setOpen(!open()),
    }),
  )
  const button = host.querySelector<HTMLButtonElement>("button")!
  expect(button.textContent).toContain("View")
  expect(button.textContent?.match(/System instructions/g)).toHaveLength(1)
  expect(reads).toBe(0)
  button.click()
  await Bun.sleep(0)
  expect(reads).toBe(1)
  expect(button.getAttribute("aria-expanded")).toBe("true")
  expect(button.textContent).toContain("Hide")
  expect(host.textContent).toContain("Instructions")
  expect(host.querySelector('[aria-label^="Copy "]')).not.toBeNull()
  button.focus()
  button.click()
  expect(document.activeElement).toBe(button)
  expect(button.getAttribute("aria-expanded")).toBe("false")
})
