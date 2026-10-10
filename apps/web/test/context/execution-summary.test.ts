import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
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
