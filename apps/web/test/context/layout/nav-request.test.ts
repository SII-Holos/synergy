import { expect, test } from "bun:test"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { createNavRequest, type NavRequestState } from "../../../src/context/layout/nav-request"

test("navigation rejects HTTP failures, preserves accepted rows and retries to an authoritative empty result", async () => {
  let failure = true
  let items = [{ id: "retained" }]
  const client = createSynergyClient({
    baseUrl: "http://navigation.test",
    fetch: Object.assign(
      async () =>
        failure
          ? Response.json({ name: "StorageBusyError", data: { message: "Unavailable" } }, { status: 503 })
          : Response.json({ items, total: items.length, nextCursor: null, unreadCompletionCount: 0 }),
      { preconnect() {} },
    ),
  })
  let state: NavRequestState | undefined
  let accepted: string[] = []
  const request = createNavRequest({
    owner: () => client,
    publish: (value) => {
      state = value
    },
  })
  const load = () =>
    request.run(
      async (client, signal) => (await client.global.nav.recent({ limit: 20 }, { throwOnError: true, signal })).data,
      (page) => {
        accepted = page.items.map((item) => item.id)
      },
    )
  try {
    await load()
    expect(state).toEqual({ loading: false, loaded: false, error: true })
    failure = false
    await load()
    expect(accepted).toEqual(["retained"])
    expect(state).toEqual({ loading: false, loaded: true, error: false })
    failure = true
    await load()
    expect(accepted).toEqual(["retained"])
    expect(state).toEqual({ loading: false, loaded: true, error: true })
    failure = false
    items = []
    await load()
    expect(accepted).toEqual([])
    expect(state).toEqual({ loading: false, loaded: true, error: false })
  } finally {
    request.dispose()
  }
})

test("superseded, foreign-client and disposed navigation responses cannot replace current data", async () => {
  let owner = {}
  let state: NavRequestState | undefined
  const applied: string[] = []
  const request = createNavRequest({
    owner: () => owner,
    publish: (value) => {
      state = value
    },
  })
  const late = Promise.withResolvers<string>()
  let firstSignal: AbortSignal | undefined
  const first = request.run(
    (_owner, signal) => {
      firstSignal = signal
      return late.promise
    },
    (value) => applied.push(value),
  )
  expect(state).toEqual({ loading: true, loaded: false, error: false })
  await request.run(
    async () => "current",
    (value) => applied.push(value),
  )
  expect(firstSignal?.aborted).toBe(true)
  late.resolve("stale")
  await first
  const foreign = Promise.withResolvers<string>()
  const changing = request.run(
    () => foreign.promise,
    (value) => applied.push(value),
  )
  owner = {}
  foreign.resolve("foreign")
  await changing
  const disposed = Promise.withResolvers<string>()
  const closing = request.run(
    () => disposed.promise,
    (value) => applied.push(value),
  )
  request.dispose()
  disposed.resolve("disposed")
  await closing
  expect(applied).toEqual(["current"])
})
