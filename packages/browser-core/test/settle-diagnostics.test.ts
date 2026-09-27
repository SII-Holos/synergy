import { describe, expect, test } from "bun:test"
import { BrowserProtocolError, CdpPageController, type CdpTransport } from "../src"
import {
  BROWSER_ACTION_SETTLE_TIMEOUT_MS,
  BROWSER_NAVIGATION_SETTLE_TIMEOUT_MS,
  BROWSER_SETTLE_TIMEOUT_MS,
  BrowserActionSchema,
} from "../src/protocol"

class FakeTransport implements CdpTransport {
  readonly calls: { method: string; params?: Record<string, unknown> }[] = []
  private listeners = new Map<string, Set<(params: unknown) => void>>()
  private objectSequence = 0
  /** Candidates the locator summary evaluation returns; a count > 1 triggers ambiguity. */
  ambiguousCandidates: unknown[] | undefined
  loading = false

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params })
    if (method === "Runtime.evaluate") {
      const expression = String(params?.expression ?? "")
      if (expression.includes("count: matches.length")) {
        const candidates = this.ambiguousCandidates
        return {
          result: {
            value: candidates === undefined ? { count: 1, candidates: [] } : { count: candidates.length, candidates },
          },
        } as T
      }
      if (expression.includes(")[0]") && expression.includes("__synergyBrowserResolve")) {
        return { result: { objectId: `candidate-object-${this.objectSequence++}` } } as T
      }
      if (expression.includes("globalThis.location")) {
        return { result: { value: { url: "https://example.com/", title: "Example" } } } as T
      }
      return { result: { value: true } } as T
    }
    if (method === "DOM.resolveNode") return { object: { objectId: "resolved-object" } } as T
    if (method === "DOM.describeNode") return { node: { backendNodeId: 41 } } as T
    if (method === "Runtime.callFunctionOn") {
      return {
        result: {
          value: {
            visible: true,
            enabled: true,
            editable: true,
            receivesEvents: true,
            box: { x: 10, y: 20, width: 100, height: 30 },
          },
        },
      } as T
    }
    if (method === "Accessibility.getFullAXTree") {
      return {
        nodes: [
          {
            nodeId: "ax-1",
            backendDOMNodeId: 42,
            role: { value: "button" },
            name: { value: "Continue with Holos" },
          },
        ],
      } as T
    }
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } } as T
    return {} as T
  }

  on(event: string, listener: (params: unknown) => void) {
    const set = this.listeners.get(event) ?? new Set<(params: unknown) => void>()
    set.add(listener)
    this.listeners.set(event, set)
    return () => set.delete(listener)
  }

  emit(event: string, params: unknown) {
    for (const listener of this.listeners.get(event) ?? []) listener(params)
  }
}

/** Virtual clock: advances by `offset` after real sleep cycles, bounded by `capMs`. */
function advancingNow(advanceToMs: number, afterRealMs: number): () => number {
  let offset = 0
  setTimeout(() => {
    offset = advanceToMs
  }, afterRealMs)
  return () => Date.now() + offset
}

const clickAction = (extra: Record<string, unknown> = {}) => ({
  type: "action" as const,
  action: {
    type: "click" as const,
    target: { kind: "css" as const, value: "button" },
    ...extra,
  },
})

describe("settle diagnostics on dynamic pages", () => {
  test("requests already in flight when settling starts do not block a quiet verdict", async () => {
    const transport = new FakeTransport()
    const controller = new CdpPageController({ pageId: "page-1", transport })
    // A long-polling request is already in flight before the action dispatches;
    // it must not block networkquiet — only NEW activity resets quietness.
    transport.emit("Network.requestWillBeSent", { requestId: "poll-1", type: "XHR" })

    const result = await controller.execute(clickAction({ settleMode: "networkquiet", settleTimeoutMs: 1_000 }))

    expect(result).toMatchObject({ type: "action", settled: true, settleReason: "networkquiet" })
    if (result.type !== "action") throw new Error("expected action result")
    expect(result.inflightRequests).toBe(1)
  })
  test("agent navigation defaults to load settle with a 15s budget and reports page state and snapshot on timeout", async () => {
    const transport = new FakeTransport()
    transport.emit("Page.frameStartedLoading", { frameId: "main-frame" })
    const controller = new CdpPageController({
      pageId: "page-1",
      transport,
      now: advancingNow(BROWSER_NAVIGATION_SETTLE_TIMEOUT_MS + 2_000, 250),
    })

    const result = await controller.execute({ type: "navigate", url: "https://example.com/", source: "agent" })

    expect(result).toMatchObject({
      type: "navigation",
      settled: false,
      settleReason: "timeout",
      page: { id: "page-1", url: "https://example.com/", isLoading: true },
    })
    if (result.type !== "navigation") throw new Error("expected navigation result")
    expect(result.settleElapsedMs).toBeGreaterThanOrEqual(BROWSER_NAVIGATION_SETTLE_TIMEOUT_MS)
    expect(result.settleElapsedMs).toBeLessThan(BROWSER_SETTLE_TIMEOUT_MS)
    expect(result.snapshot).toBeDefined()
  })

  test("actions default to networkquiet settle with a 10s budget and still attach a snapshot on timeout", async () => {
    const transport = new FakeTransport()
    transport.emit("Page.frameStartedLoading", { frameId: "main-frame" })
    const controller = new CdpPageController({
      pageId: "page-1",
      transport,
      now: advancingNow(BROWSER_ACTION_SETTLE_TIMEOUT_MS + 2_000, 250),
    })

    const result = await controller.execute(clickAction())

    expect(result).toMatchObject({
      type: "action",
      settled: false,
      settleReason: "timeout",
    })
    if (result.type !== "action") throw new Error("expected action result")
    expect(result.settleElapsedMs).toBeGreaterThanOrEqual(BROWSER_ACTION_SETTLE_TIMEOUT_MS)
    expect(result.settleElapsedMs).toBeLessThan(BROWSER_NAVIGATION_SETTLE_TIMEOUT_MS)
    expect(result.snapshot).toBeDefined()
  })

  test("settleTimeoutMs is schema-bounded to the 30s hard cap", () => {
    expect(() => BrowserActionSchema.parse(clickAction({ settleTimeoutMs: 31_000 }).action)).toThrow()
    expect(BrowserActionSchema.parse(clickAction({ settleTimeoutMs: 30_000 }).action).settleTimeoutMs).toBe(30_000)
    expect(BROWSER_SETTLE_TIMEOUT_MS).toBe(30_000)
  })

  test("ambiguous locators carry bounded diagnostic candidates with clickable refs and redaction", async () => {
    const transport = new FakeTransport()
    transport.ambiguousCandidates = [
      {
        tag: "button",
        role: "button",
        name: "Save token=abc123",
        id: "dup-1",
        class: "primary",
        visible: true,
        bounds: { x: 1, y: 2, width: 80, height: 24 },
        receivesEvents: true,
      },
      {
        tag: "button",
        role: null,
        name: "Save",
        id: "dup-2",
        class: "secondary",
        visible: false,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
        receivesEvents: false,
      },
    ]
    const controller = new CdpPageController({ pageId: "page-1", transport })

    let caught: BrowserProtocolError | undefined
    try {
      await controller.execute(clickAction({ settleMode: "none" }))
    } catch (error) {
      caught = error as BrowserProtocolError
    }
    expect(caught?.code).toBe("browser_locator_ambiguous")
    expect(caught?.retryable).toBe(true)
    expect(caught?.snapshotId).toMatch(/^cand-0-\d+$/)
    const candidates = caught?.obstruction?.candidates
    expect(candidates).toHaveLength(2)
    expect(candidates?.[0]).toMatchObject({
      tag: "button",
      role: "button",
      id: "dup-1",
      class: "primary",
      visible: true,
      bounds: { x: 1, y: 2, width: 80, height: 24 },
      receivesEvents: true,
      frame: "main-frame",
    })
    expect(candidates?.[0]?.name).toBe('Save token="[redacted]"')
    expect(candidates?.[0]?.ref).toMatch(/^@/)
    expect(candidates?.[1]).toMatchObject({ role: null, visible: false, receivesEvents: false })

    // The reported candidate ref must resolve to a clickable element in a follow-up action.
    const ref = candidates?.[0]?.ref
    const snapshotId = caught?.snapshotId
    if (!ref || !snapshotId) throw new Error("expected a usable candidate ref")
    const result = await controller.execute({
      type: "action",
      action: {
        type: "click",
        target: { kind: "ref", snapshotId, ref },
        settleMode: "none",
      },
    })
    expect(result).toMatchObject({ type: "action", action: "click", settled: true })
    expect(transport.calls.some((call) => call.method === "DOM.resolveNode")).toBe(true)
  })
})
