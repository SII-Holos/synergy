import { expect, test } from "bun:test"
import { createRoot, sharedConfig } from "solid-js"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { useLibraryStats } from "../../../src/components/library/stats/use-library-stats"

async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

test("library stats keeps its snapshot on HTTP failure and retry publishes one response", async () => {
  let fail = false
  let calls = 0
  let computedAt = 1
  const client = createSynergyClient({
    baseUrl: "http://fixture",
    fetch: (async () => {
      calls++
      return fail
        ? Response.json({ message: "unavailable" }, { status: 503 })
        : Response.json({
            overview: {},
            memoryDistribution: {},
            experienceRL: {},
            retrieval: {},
            scopes: {},
            timeSeries: {},
            computedAt,
          })
    }) as unknown as typeof fetch,
  })
  const previous = sharedConfig.context
  sharedConfig.context = { id: "", count: 0, async: true, resources: {} } as never
  const mounted = createRoot((dispose) => ({ dispose, stats: useLibraryStats({ client }) }))
  try {
    await settle()
    expect(mounted.stats.data()?.computedAt).toBe(1)
    expect(calls).toBe(1)
    fail = true
    await mounted.stats.recompute()
    expect(mounted.stats.data()?.computedAt).toBe(1)
    expect(mounted.stats.error()).toBe("unavailable")
    expect(mounted.stats.loading()).toBe(false)
    fail = false
    computedAt = 2
    await mounted.stats.recompute()
    expect(mounted.stats.data()?.computedAt).toBe(2)
    expect(mounted.stats.error()).toBeNull()
    expect(calls).toBe(3)
  } finally {
    mounted.dispose()
    sharedConfig.context = previous
  }
})

test("initial HTTP failure settles without fabricated zeros and can recover", async () => {
  const client = createSynergyClient({
    baseUrl: "http://fixture",
    fetch: (async () => Response.json({ message: "offline" }, { status: 503 })) as unknown as typeof fetch,
  })
  const previous = sharedConfig.context
  sharedConfig.context = { id: "", count: 0, async: true, resources: {} } as never
  const mounted = createRoot((dispose) => ({ dispose, stats: useLibraryStats({ client }) }))
  try {
    await settle()
    expect(mounted.stats.data()).toBeNull()
    expect(mounted.stats.error()).toBe("offline")
    expect(mounted.stats.loading()).toBe(false)
  } finally {
    mounted.dispose()
    sharedConfig.context = previous
  }
})
