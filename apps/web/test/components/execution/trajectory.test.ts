import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import {
  createSynergyClient,
  type Event,
  type ExecutionTrajectoryNode,
  type ExecutionSummary,
} from "@ericsanchezok/synergy-sdk/client"
import { createExecutionTrajectory } from "../../../src/components/execution/trajectory"

const row = (id: number, status: ExecutionTrajectoryNode["status"] = "completed"): ExecutionTrajectoryNode => ({
  id: String(id),
  sessionID: "root",
  runID: "round",
  parentID: null,
  kind: "tool",
  title: "read",
  preview: "",
  started: id,
  status,
  revision: id,
  source: "recorded",
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
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test("returning from an anchor shares the reactive latest read with the explicit navigation", async () => {
  const requests: { request: Request; resolve: (response: Response) => void }[] = []
  const client = createSynergyClient({
    baseUrl: "http://fixture.local",
    fetch: Object.assign(
      (request: RequestInfo | URL) =>
        new Promise<Response>((resolve) => requests.push({ request: request as Request, resolve })),
      { preconnect: fetch.preconnect },
    ),
  })
  const [anchor, setAnchor] = createSignal("selected")
  const setup = createRoot((dispose) => ({
    dispose,
    trajectory: createExecutionTrajectory({
      sdk: { client, event: createGlobalEmitter<{ [key in Event["type"]]: Extract<Event, { type: key }> }>() },
      sessionID: () => "root",
      runID: () => "",
      actor: () => "",
      kind: () => "",
      status: () => "",
      query: () => "",
      anchor,
      connectionVersion: () => 0,
    }),
  }))
  const page = () =>
    Response.json({ sessionID: "root", revision: 1, total: 1, items: [row(1)], nextCursor: null, previousCursor: null })
  try {
    await tick()
    requests[0].resolve(page())
    await tick()
    setAnchor("")
    const loading = setup.trajectory.load(undefined, "latest")
    await tick()
    expect(requests).toHaveLength(2)
    expect(requests[1].request.signal.aborted).toBe(false)
    requests[1].resolve(page())
    await loading
    expect(setup.trajectory.state.rows.map((node) => node.id)).toEqual(["1"])
  } finally {
    setup.dispose()
  }
})

test("true reconnects supersede identical pending queries and reject old-connection pages", async () => {
  const requests: { signal: AbortSignal; resolve: (response: Response) => void }[] = []
  const client = createSynergyClient({
    baseUrl: "http://fixture.local",
    fetch: Object.assign(
      (request: RequestInfo | URL) =>
        new Promise<Response>((resolve) => {
          requests.push({ signal: (request as Request).signal, resolve })
        }),
      { preconnect: fetch.preconnect },
    ),
  })
  const [connectionVersion, reconnect] = createSignal(0)
  const setup = createRoot((dispose) => ({
    dispose,
    trajectory: createExecutionTrajectory({
      sdk: { client, event: createGlobalEmitter<{ [key in Event["type"]]: Extract<Event, { type: key }> }>() },
      sessionID: () => "root",
      runID: () => "",
      actor: () => "",
      kind: () => "",
      status: () => "",
      query: () => "",
      anchor: () => "",
      connectionVersion,
    }),
  }))
  try {
    await tick()
    reconnect(1)
    await tick()
    expect(requests).toHaveLength(2)
    expect(requests[0].signal.aborted).toBe(true)
    reconnect(2)
    await tick()
    expect(requests).toHaveLength(3)
    expect(requests[1].signal.aborted).toBe(true)
    for (const [index, request] of requests.entries())
      request.resolve(
        Response.json({
          sessionID: "root",
          revision: index + 1,
          total: 1,
          items: [row(index + 1)],
          nextCursor: null,
          previousCursor: null,
        }),
      )
    await tick()
    await tick()
    expect(setup.trajectory.state.rows.map((node) => node.id)).toEqual(["3"])
  } finally {
    setup.dispose()
  }
})

test("a live event during snapshot loading overlays the older response and retains history", async () => {
  const pending: ((value: Response) => void)[] = []
  const urls: URL[] = []
  const event = createGlobalEmitter<{ [key in Event["type"]]: Extract<Event, { type: key }> }>()
  const client = createSynergyClient({
    baseUrl: "http://fixture.local",
    fetch: Object.assign(
      (request: Parameters<typeof fetch>[0]) => {
        urls.push(new URL(request instanceof Request ? request.url : request.toString()))
        return new Promise<Response>((resolve) => pending.push(resolve))
      },
      {
        preconnect: fetch.preconnect,
      },
    ),
  })
  const [connected] = createSignal(true)
  const [connectionVersion, reconnect] = createSignal(0)
  let dispose = () => {}
  const controller = createRoot((cleanup) => {
    dispose = cleanup
    return createExecutionTrajectory({
      sdk: {
        client,
        event,
      },
      sessionID: () => "root",
      runID: () => "",
      actor: () => "",
      kind: () => "",
      status: () => "",
      query: () => "",
      anchor: () => "",
      connectionVersion,
    })
  })
  try {
    await tick()
    const older = pending.shift()!
    const update = {
      sessionID: "root",
      revision: 2,
      summary: summary(2),
      roundSummaries: [],
      upserts: [row(2, "failed"), row(3)],
      removed: [],
    }
    event.emit("execution.updated", { type: "execution.updated", properties: update })
    older(
      Response.json({
        sessionID: "root",
        revision: 1,
        total: 2,
        items: [row(1), row(2)],
        nextCursor: null,
        previousCursor: null,
      }),
    )
    await tick()
    await tick()
    expect(controller.state.error).toBe(false)
    expect(controller.state.rows.map((node) => node.id)).toEqual(["1", "2", "3"])
    expect(controller.state.rows[1].status).toBe("failed")
    controller.setHistory(true)
    event.emit("execution.updated", {
      type: "execution.updated",
      properties: { ...update, revision: 3, upserts: [row(4)] },
    })
    expect(controller.state.rows.map((node) => node.id)).toEqual(["1", "2", "3"])
    expect(controller.state.pending).toBe(1)
    reconnect(1)
    await tick()
    expect(urls.at(-1)?.searchParams.get("anchor")).toBe("2")
    pending.shift()!(
      Response.json({
        sessionID: "root",
        revision: 1,
        total: 1,
        items: [row(5)],
        nextCursor: null,
        previousCursor: null,
      }),
    )
    await tick()
    await tick()
    expect(controller.state.rows.map((node) => node.id)).toEqual(["5"])
    expect(controller.state.history).toBe(true)
    event.emit("execution.updated", {
      type: "execution.updated",
      properties: { ...update, revision: 2, previousRevision: 1, upserts: [row(5, "failed")] },
    })
    expect(controller.state.rows[0].status).toBe("failed")
  } finally {
    dispose()
  }
}, 5000)

test("an inactive trajectory rejects a late aborted page", async () => {
  const pending = Promise.withResolvers<Response>()
  let signal: AbortSignal | undefined
  const client = createSynergyClient({
    baseUrl: "http://fixture.local",
    fetch: Object.assign(
      (request: RequestInfo | URL) => {
        signal = (request as Request).signal
        return pending.promise
      },
      { preconnect: fetch.preconnect },
    ),
  })
  const [enabled, enable] = createSignal(true)
  const setup = createRoot((dispose) => ({
    dispose,
    trajectory: createExecutionTrajectory({
      sdk: { client, event: createGlobalEmitter<{ [key in Event["type"]]: Extract<Event, { type: key }> }>() },
      sessionID: () => "root",
      runID: () => "",
      actor: () => "",
      kind: () => "",
      status: () => "",
      query: () => "",
      anchor: () => "",
      connectionVersion: () => 0,
      enabled,
    }),
  }))
  try {
    await tick()
    enable(false)
    expect(signal?.aborted).toBe(true)
    pending.resolve(
      Response.json({
        sessionID: "root",
        revision: 999,
        total: 999,
        items: [row(999)],
        nextCursor: null,
        previousCursor: null,
      }),
    )
    await tick()
    await tick()
    expect(setup.trajectory.state.rows).toEqual([])
    expect(setup.trajectory.state.revision).toBe(-1)
    expect(setup.trajectory.state.loading).toBe(false)
  } finally {
    setup.dispose()
  }
})

test("a gap in execution deltas restores a snapshot around the history anchor", async () => {
  let requests = 0
  let recoveredAnchor: string | null = null
  const event = createGlobalEmitter<{ [key in Event["type"]]: Extract<Event, { type: key }> }>()
  const client = createSynergyClient({
    baseUrl: "http://fixture.local",
    fetch: Object.assign(
      async (request: Parameters<typeof fetch>[0]) => {
        requests++
        recoveredAnchor = new URL(request instanceof Request ? request.url : request.toString()).searchParams.get(
          "anchor",
        )
        return Response.json({
          sessionID: "root",
          revision: requests === 1 ? 1 : 6,
          total: 2,
          items: [row(1), row(2)],
          nextCursor: "later",
          previousCursor: null,
        })
      },
      { preconnect: fetch.preconnect },
    ),
  })
  let dispose = () => {}
  const controller = createRoot((cleanup) => {
    dispose = cleanup
    return createExecutionTrajectory({
      sdk: {
        client,
        event,
      },
      sessionID: () => "root",
      runID: () => "",
      actor: () => "",
      kind: () => "",
      status: () => "",
      query: () => "",
      anchor: () => "",
      connectionVersion: () => 0,
    })
  })
  try {
    await tick()
    await tick()
    controller.setHistory(true)
    event.emit("execution.updated", {
      type: "execution.updated",
      properties: {
        sessionID: "root",
        revision: 6,
        previousRevision: 4,
        summary: summary(6),
        roundSummaries: [],
        upserts: [row(2)],
        removed: [],
      },
    })
    await tick()
    await tick()
    expect(requests).toBe(2)
    expect(String(recoveredAnchor)).toBe("2")
    expect(controller.state.rows.map((node) => node.id)).toEqual(["1", "2"])
    expect(controller.state.history).toBe(true)
  } finally {
    dispose()
  }
})

test("paging a long trajectory remains bounded and resumes without losing the reading window", async () => {
  const all = Array.from({ length: 1000 }, (_, index) => row(index))
  const requests: URL[] = []
  const event = createGlobalEmitter<{ [key in Event["type"]]: Extract<Event, { type: key }> }>()
  const client = createSynergyClient({
    baseUrl: "http://fixture.local",
    fetch: Object.assign(
      async (request: Parameters<typeof fetch>[0]) => {
        const url = new URL(request instanceof Request ? request.url : request.toString())
        requests.push(url)
        const anchor = url.searchParams.get("anchor")
        const position = url.searchParams.get("position")
        const limit = Number(url.searchParams.get("limit") ?? 100)
        const index = all.findIndex((node) => node.id === anchor)
        const start =
          anchor === "latest"
            ? Math.max(0, all.length - limit)
            : position === "before"
              ? Math.max(0, index - limit)
              : position === "after"
                ? Math.max(0, index + 1)
                : Math.max(0, index - Math.floor(limit / 2))
        return Response.json({
          sessionID: "root",
          revision: 1,
          total: all.length,
          items: all.slice(start, start + limit),
          previousCursor: start ? "previous" : null,
          nextCursor: start + limit < all.length ? "next" : null,
        })
      },
      { preconnect: fetch.preconnect },
    ),
  })
  const [enabled, enable] = createSignal(true)
  const [connected] = createSignal(true)
  let dispose = () => {}
  const controller = createRoot((cleanup) => {
    dispose = cleanup
    return createExecutionTrajectory({
      sdk: {
        client,
        event,
      },
      sessionID: () => "root",
      runID: () => "",
      actor: () => "",
      kind: () => "",
      status: () => "",
      query: () => "",
      anchor: () => "",
      connectionVersion: () => 0,
      enabled,
    })
  })
  try {
    await tick()
    await tick()
    for (let index = 0; index < 5; index++) await controller.load(controller.state.previous!, undefined, "previous")
    expect(controller.state.rows).toHaveLength(500)
    expect(controller.state.rows[0].id).toBe("400")
    expect(controller.state.rows.at(-1)?.id).toBe("899")
    await controller.load(controller.state.next!, undefined, "next")
    expect(controller.state.rows).toHaveLength(500)
    expect(controller.state.rows[0].id).toBe("500")
    expect(controller.state.rows.at(-1)?.id).toBe("999")
    controller.setHistory(true)
    const count = requests.length
    enable(false)
    await tick()
    enable(true)
    await tick()
    await tick()
    expect(requests).toHaveLength(count + 1)
    expect(requests.at(-1)?.searchParams.get("anchor")).not.toBe("latest")
    expect(controller.state.history).toBe(true)
    expect(controller.state.rows[0].id).toBe("500")
  } finally {
    dispose()
  }
}, 5000)

test("a summary-only gap during a pending page recovers the window and notifies expanded branches", async () => {
  const pending: ((response: Response) => void)[] = []
  const event = createGlobalEmitter<{ [key in Event["type"]]: Extract<Event, { type: key }> }>()
  const client = createSynergyClient({
    baseUrl: "http://fixture.local",
    fetch: Object.assign(() => new Promise<Response>((resolve) => pending.push(resolve)), {
      preconnect: fetch.preconnect,
    }),
  })
  const setup = createRoot((dispose) => ({
    dispose,
    trajectory: createExecutionTrajectory({
      sdk: { client, event },
      sessionID: () => "root",
      runID: () => "",
      actor: () => "",
      kind: () => "",
      status: () => "",
      query: () => "",
      anchor: () => "",
      connectionVersion: () => 0,
    }),
  }))
  const page = (revision: number) =>
    Response.json({
      sessionID: "root",
      revision,
      total: 1,
      items: [row(revision)],
      nextCursor: null,
      previousCursor: null,
    })
  try {
    await tick()
    event.emit("execution.updated", {
      type: "execution.updated",
      properties: {
        sessionID: "root",
        revision: 3,
        previousRevision: 3,
        summary: summary(3),
        roundSummaries: [],
        upserts: [],
        removed: [],
      },
    })
    pending[0](page(1))
    await tick()
    await tick()
    expect(setup.trajectory.recoveryVersion()).toBe(1)
    expect(pending).toHaveLength(2)
    pending[1](page(3))
    await tick()
    await tick()
    expect(setup.trajectory.state.rows.map((node) => node.id)).toEqual(["3"])
    expect(setup.trajectory.state.loading).toBe(false)
  } finally {
    setup.dispose()
  }
})
