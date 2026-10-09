import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import {
  createSynergyClient,
  type ExecutionContextSnapshot,
  type EventExecutionUpdated,
} from "@ericsanchezok/synergy-sdk/client"
import { createExecutionContext } from "../../src/context/execution-context"

const item = (callID: string, started: number): ExecutionContextSnapshot => ({
  sessionID: "session",
  callID,
  nodeID: callID,
  runID: "round",
  requestNumber: started + 1,
  roundNumber: 1,
  started,
  status: "completed",
  modelID: "model",
  providerID: "provider",
  inputTokens: 10,
  contextLimit: 100,
  outputTokens: 5,
  cacheHit: 0.5,
  elapsedMs: 10,
  retries: 0,
  usage: null,
  compactedBefore: false,
  requestAvailable: true,
})

test("changing the retained request and receiving a new latest request never rewrites other history entities", async () => {
  const originals = [item("third", 3), item("second", 2), item("first", 1)]
  const client = createSynergyClient({
    baseUrl: "http://fixture.test",
    fetch: Object.assign(
      async () => Response.json({ sessionID: "session", revision: 1, items: originals, total: 3, nextCursor: null }),
      { preconnect: fetch.preconnect },
    ),
  })
  const [selected, setSelected] = createSignal("second")
  let receive: ((event: EventExecutionUpdated["properties"]) => void) | undefined
  const setup = createRoot((dispose) => ({
    dispose,
    history: createExecutionContext({
      client,
      sessionID: () => "session",
      runID: () => "",
      active: () => true,
      selected,
      connectionVersion: () => 1,
      subscribe: (callback) => {
        receive = callback
        return () => {
          receive = undefined
        }
      },
    }),
  }))
  try {
    await Bun.sleep(0)
    for (const callID of ["third", "first", "second", "third", "second"]) {
      setSelected(callID)
      await Bun.sleep(0)
      expect(setup.history.snapshot()?.callID).toBe(callID)
      expect(JSON.parse(JSON.stringify(setup.history.state.items))).toEqual(originals)
      expect(setup.history.state.latest?.callID).toBe("third")
    }
    receive?.({
      sessionID: "session",
      revision: 2,
      contextUpserts: [item("fourth", 4)],
    } as EventExecutionUpdated["properties"])
    expect(setup.history.state.items.map((entry) => entry.callID)).toEqual(["fourth", "third", "second", "first"])
    expect(JSON.parse(JSON.stringify(setup.history.state.items.slice(1)))).toEqual(originals)
    expect(setup.history.state.latest?.callID).toBe("fourth")
    expect(setup.history.snapshot()?.callID).toBe("second")
    const retained = setup.history.snapshot()
    receive?.({
      sessionID: "session",
      revision: 3,
      contextUpserts: [{ ...item("second", 2), inputTokens: 12 }],
    } as EventExecutionUpdated["properties"])
    expect(setup.history.snapshot()).toBe(retained)
    expect(setup.history.snapshot()?.inputTokens).toBe(12)
    expect(setup.history.state.items.map((entry) => entry.callID)).toEqual(["fourth", "third", "second", "first"])
    expect(setup.history.state.latest?.inputTokens).toBe(10)
  } finally {
    setup.dispose()
  }
})
test("late history pages merge newer events and closed readers ignore late replies", async () => {
  const pending: { request: Request; resolve: (response: Response) => void }[] = []
  const client = createSynergyClient({
    baseUrl: "http://fixture.test",
    fetch: Object.assign(
      (request: RequestInfo | URL) =>
        new Promise<Response>((resolve) => pending.push({ request: request as Request, resolve })),
      { preconnect: fetch.preconnect },
    ),
  })
  let receive: ((event: EventExecutionUpdated["properties"]) => void) | undefined
  const [active, setActive] = createSignal(true)
  const [selected] = createSignal("older")
  const setup = createRoot((dispose) => ({
    dispose,
    history: createExecutionContext({
      client,
      sessionID: () => "session",
      runID: () => "",
      active,
      selected,
      connectionVersion: () => 1,
      subscribe: (callback) => {
        receive = callback
        return () => {
          receive = undefined
        }
      },
    }),
  }))
  const reply = (index: number, revision: number, items: ExecutionContextSnapshot[]) =>
    pending[index].resolve(
      Response.json({ sessionID: "session", revision, items, total: items.length, nextCursor: "older-page" }),
    )
  try {
    await Bun.sleep(0)
    expect(pending).toHaveLength(1)
    receive?.({
      sessionID: "session",
      revision: 2,
      contextUpserts: [item("newer", 2)],
    } as EventExecutionUpdated["properties"])
    reply(0, 1, [item("older", 1)])
    await Bun.sleep(0)
    expect(setup.history.state.items.map((entry) => entry.callID)).toEqual(["newer", "older"])
    expect(setup.history.state.revision).toBe(2)
    const next = setup.history.load(true)
    await Bun.sleep(0)
    setActive(false)
    expect(pending[1].request.signal.aborted).toBe(true)
    reply(1, 3, [item("late", 3)])
    await next
    expect(setup.history.state.items.some((entry) => entry.callID === "late")).toBe(false)
  } finally {
    setup.dispose()
  }
})
