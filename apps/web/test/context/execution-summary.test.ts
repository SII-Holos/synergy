import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import {
  type ExecutionSummary,
  type ExecutionProjection,
  type EventExecutionUpdated,
  createSynergyClient,
} from "@ericsanchezok/synergy-sdk/client"
import { createExecutionSummary } from "../../src/context/execution-summary"

test("navigation, focus and reconnect do not request complete execution history before opening details", async () => {
  const requests: Request[] = []
  const client = createSynergyClient({
    baseUrl: "http://fixture.test",
    fetch: Object.assign(
      async (request: RequestInfo | URL) => {
        requests.push(request as Request)
        return new Response(null, { status: 503 })
      },
      { preconnect: fetch.preconnect },
    ),
  })
  const [sessionID, select] = createSignal<string | undefined>("old")
  const [connected, connect] = createSignal(true)
  const [visible, show] = createSignal(true)
  const setup = createRoot((dispose) => ({
    dispose,
    summary: createExecutionSummary({
      client,
      sessionID,
      connected,
      visible,
      available: () => true,
      subscribe: () => () => {},
    }),
  }))
  try {
    await Bun.sleep(0)
    select("older")
    show(false)
    show(true)
    connect(false)
    connect(true)
    await Bun.sleep(0)
    expect(requests).toHaveLength(0)
    await setup.summary.refresh()
    expect(requests).toHaveLength(1)
    expect(setup.summary.state.error).toBe(true)
    show(false)
    show(true)
    await Bun.sleep(0)
    expect(requests).toHaveLength(2)
    select("another")
    show(false)
    show(true)
    await Bun.sleep(0)
    expect(requests).toHaveLength(2)
    expect(setup.summary.state.error).toBe(false)
    expect(setup.summary.state.loading).toBe(false)
  } finally {
    setup.dispose()
  }
})

test("switching sessions aborts details and rejects a late response even when returning to the same session", async () => {
  const pending: { request: Request; resolve: (response: Response) => void }[] = []
  const client = createSynergyClient({
    baseUrl: "http://fixture.test",
    fetch: Object.assign(
      (request: RequestInfo | URL) =>
        new Promise<Response>((resolve) => {
          pending.push({ request: request as Request, resolve })
        }),
      { preconnect: fetch.preconnect },
    ),
  })
  const [sessionID, select] = createSignal<string | undefined>("old")
  const setup = createRoot((dispose) => ({
    dispose,
    summary: createExecutionSummary({
      client,
      sessionID,
      connected: () => true,
      visible: () => true,
      available: () => true,
      subscribe: () => () => {},
    }),
  }))
  try {
    const loading = setup.summary.refresh()
    await Bun.sleep(0)
    expect(pending).toHaveLength(1)
    select(undefined)
    select("old")
    expect(pending[0].request.signal.aborted).toBe(true)
    pending[0].resolve(Response.json({ sessionID: "old", clockID: "server", revision: 1, sampledAt: 1 }))
    await loading
    expect(setup.summary.state.summary).toBeUndefined()
    expect(setup.summary.state.loading).toBe(false)
    expect(pending).toHaveLength(1)
  } finally {
    setup.dispose()
  }
})

test("activating a requested detail shares its pending read and hiding aborts it before resuming", async () => {
  const pending: { request: Request; resolve(response: Response): void }[] = []
  const client = createSynergyClient({
    baseUrl: "http://fixture.test",
    fetch: Object.assign(
      (request: RequestInfo | URL) =>
        new Promise<Response>((resolve) => {
          pending.push({ request: request as Request, resolve })
        }),
      { preconnect: fetch.preconnect },
    ),
  })
  const [visible, show] = createSignal(false)
  const setup = createRoot((dispose) => ({
    dispose,
    summary: createExecutionSummary({
      client,
      visible,
      sessionID: () => "session",
      connected: () => true,
      available: () => true,
      subscribe: () => () => {},
    }),
  }))
  try {
    const loading = setup.summary.refresh()
    show(true)
    await Bun.sleep(0)
    expect(pending).toHaveLength(1)
    expect(pending[0].request.signal.aborted).toBe(false)
    show(false)
    expect(pending[0].request.signal.aborted).toBe(true)
    pending[0].resolve(Response.json({ sessionID: "session", clockID: "server", revision: 1, sampledAt: 1 }))
    await loading
    expect(setup.summary.state.summary).toBeUndefined()
    show(true)
    await Bun.sleep(0)
    expect(pending).toHaveLength(2)
    pending[1].resolve(Response.json({ sessionID: "session", clockID: "server", revision: 2, sampledAt: 2 }))
    await Bun.sleep(0)
    expect(setup.summary.state.summary?.revision).toBe(2)
  } finally {
    setup.dispose()
  }
})

function summary(revision: number): ExecutionSummary {
  const metric = () => ({ known: 0, unknown: 0, total: 0 })
  const accounting = () => ({
    version: 1 as const,
    calls: 0,
    importedCalls: 0,
    localCalls: 0,
    attempts: 0,
    unobservedCalls: 0,
    journalGaps: 0,
    legacy: { cost: 0, messages: 0 },
    tokens: {
      input: metric(),
      uncached: metric(),
      cacheRead: metric(),
      cacheWrite: metric(),
      output: metric(),
      reasoning: metric(),
      total: metric(),
    },
    apiEstimate: metric(),
    subscriptionEquivalent: metric(),
    unclassifiedEquivalent: metric(),
    reported: { currencies: {}, unreported: 0 },
    units: {},
    cacheWrites: {},
  })
  const rate = () => ({ value: null, tokens: 0, milliseconds: 0, samples: 0, excluded: 0, reasons: {} })
  const latency = { samples: 0, excluded: 0, totalMs: 0, meanMs: null, p50Ms: null, p95Ms: null }
  return {
    sessionID: "root",
    revision,
    clockID: "test",
    sampledAt: 0,
    computedAt: 0,
    cost: {
      state: "unrecorded",
      reported: [],
      estimates: [],
      equivalent: null,
      missing: 0,
      historical: 0,
      knownUSD: 0,
    },
    activityTotal: 0,
    humanInputs: 0,
    taskInstructions: 0,
    status: "running",
    elapsedLowerBound: false,
    elapsedMs: 0,
    elapsedActive: true,
    accounting: accounting(),
    own: accounting(),
    descendants: accounting(),
    rates: { generation: rate(), endToEnd: rate() },
    cache: { ratio: null, observedRatio: null, read: 0, input: 0, samples: 0, excluded: 0 },
    latency: { headers: latency, firstByte: latency, ttft: latency, request: latency, generation: latency },
    outcomes: {
      completed: 0,
      failed: 0,
      cancelled: 0,
      interrupted: 0,
      running: 0,
      retries: 0,
      logicalRetries: 0,
      transportRetries: 0,
      rootTasks: 0,
    },
    tools: [],
    context: null,
    contextDistribution: null,
    tasks: [],
    rounds: [],
    coverage: { recorded: 3, messages: 0, gaps: 0, partial: false },
    lanes: [],
  }
}

test("negotiated preparation and failure preserve the last complete summary and its revision", async () => {
  let receive!: (value: EventExecutionUpdated["properties"]) => void
  let project!: (value: ExecutionProjection) => void
  let renewals = 0
  const requests: unknown[] = []
  const client = createSynergyClient({
    baseUrl: "http://fixture.test",
    fetch: Object.assign(
      async (request: RequestInfo | URL) => {
        requests.push(request)
        return new Response(null, { status: 503 })
      },
      { preconnect: fetch.preconnect },
    ),
  })
  const setup = createRoot((dispose) => ({
    dispose,
    summary: createExecutionSummary({
      client,
      sessionID: () => "root",
      available: () => true,
      connected: () => true,
      visible: () => true,
      subscribe(listener) {
        receive = listener
        return () => {}
      },
      projection: {
        enabled: () => true,
        renew() {
          renewals++
        },
        subscribe(listener) {
          project = listener
          return () => {}
        },
      },
    }),
  }))
  try {
    const accepted = summary(7)
    receive({ sessionID: "root", revision: 7, summary: accepted, roundSummaries: [], upserts: [], removed: [] })
    const base = { sessionID: "root", revision: 20, previousRevision: 19, contexts: [], contextTotal: 0 }
    project({ ...base, state: "preparing", progress: { stage: "parts", prepared: 32 } })
    expect(setup.summary.state.loading).toBe(true)
    expect(setup.summary.state.summary).toEqual(accepted)
    project({ ...base, state: "failed", error: { kind: "Error", message: "Preparation failed", retryable: true } })
    expect(setup.summary.state.loading).toBe(false)
    expect(setup.summary.state.error).toBe(true)
    expect(setup.summary.state.summary).toEqual(accepted)
    await setup.summary.refresh()
    expect(renewals).toBe(1)
    expect(requests).toHaveLength(0)
    expect(setup.summary.state.summary?.revision).toBe(7)
  } finally {
    setup.dispose()
  }
})
