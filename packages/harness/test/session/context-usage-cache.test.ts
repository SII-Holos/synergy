import { afterAll, expect, spyOn, test } from "bun:test"
import { Worker } from "node:worker_threads"
import { ContextUsageEstimator } from "../../src/session/context-usage-estimator"
import { ContextCategoryKeys } from "../../src/session/context-usage-schema"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())
const identity = { sessionID: "cache-session", providerID: "provider", modelID: "model" }
function request(result = "tool result"): ContextUsageEstimator.Request {
  const categories = Object.fromEntries(
    ContextCategoryKeys.map((category) => [
      category,
      [
        {
          sample: category === "toolResults" ? result : category,
          sourceCharacters: category === "toolResults" ? result.length : category.length,
        },
      ],
    ]),
  ) as ContextUsageEstimator.Request["categories"]
  return {
    categories,
    sampledCharacters: Object.values(categories)
      .flat()
      .reduce((sum, entry) => sum + entry.sample.length, 0),
    truncated: false,
  }
}

test("category caching measures only changed samples and distinguishes reductions, models and sessions", () =>
  runtime.run(async () => {
    using post = spyOn(Worker.prototype, "postMessage")
    const first = await ContextUsageEstimator.estimate(request(), identity)
    expect(first).toBeDefined()
    const count = post.mock.calls.length
    expect(await ContextUsageEstimator.estimate(request(), identity)).toEqual(first)
    expect(post.mock.calls).toHaveLength(count)
    const changed = await ContextUsageEstimator.estimate(request("longer tool result"), identity)
    expect(changed!.categories.toolResults).toBeGreaterThan(first!.categories.toolResults)
    const sent = post.mock.calls.at(-1)![0] as ContextUsageEstimator.Request
    expect(
      Object.entries(sent.categories)
        .filter(([, value]) => value.length)
        .map(([key]) => key),
    ).toEqual(["toolResults"])
    expect(sent.sampledCharacters).toBe("longer tool result".length)
    const smaller = await ContextUsageEstimator.estimate(request("x"), identity)
    expect(smaller!.categories.toolResults).toBe(1)
    for (const variant of [
      { ...identity, modelID: "next" },
      { ...identity, sessionID: "other" },
    ]) {
      await ContextUsageEstimator.estimate(request(), variant)
      const fresh = post.mock.calls.at(-1)![0] as ContextUsageEstimator.Request
      expect(Object.values(fresh.categories).every((values) => values.length)).toBe(true)
    }
  }))

test("512 category entries evict least recently used requests without sharing between runtimes", async () => {
  await using isolated = await testRuntime()
  await isolated.run(async () => {
    using post = spyOn(Worker.prototype, "postMessage")
    for (let index = 0; index < 64; index++)
      await ContextUsageEstimator.estimate(request(), { ...identity, sessionID: String(index) })
    const count = post.mock.calls.length
    await ContextUsageEstimator.estimate(request(), { ...identity, sessionID: "0" })
    expect(post.mock.calls).toHaveLength(count)
    await ContextUsageEstimator.estimate(request(), { ...identity, sessionID: "64" })
    await ContextUsageEstimator.estimate(request(), { ...identity, sessionID: "0" })
    expect(post.mock.calls).toHaveLength(count + 1)
    await ContextUsageEstimator.estimate(request(), { ...identity, sessionID: "1" })
    expect(post.mock.calls).toHaveLength(count + 2)
  })
  await runtime.run(async () => {
    using post = spyOn(Worker.prototype, "postMessage")
    await ContextUsageEstimator.estimate(request(), { ...identity, sessionID: "0" })
    expect(post.mock.calls).toHaveLength(1)
  })
})

test("timeouts and Runtime shutdown release workers and reject late cache writes", async () => {
  await using isolated = await testRuntime()
  await isolated.run(async () => {
    using post = spyOn(Worker.prototype, "postMessage").mockImplementation(() => {})
    const first = ContextUsageEstimator.estimate(request(), identity)
    const second = ContextUsageEstimator.estimate(request(), identity)
    expect(await ContextUsageEstimator.estimate(request(), identity)).toBeUndefined()
    expect(await first).toBeUndefined()
    expect(await second).toBeUndefined()
    const closing = ContextUsageEstimator.estimate(request(), identity)
    const started = performance.now()
    await isolated.close()
    expect(await closing).toBeUndefined()
    expect(performance.now() - started).toBeLessThan(1000)
  })
})
