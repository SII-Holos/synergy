import { afterAll, expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { Hono } from "hono"
import { generateSpecs } from "hono-openapi"
import { StatsRoute } from "../../src/stats/routes/stats"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"

const runtime = await testRuntime()
afterAll(() => runtime.close())
const app = new Hono().route("/global/stats", StatsRoute())

test("usage routes preserve OpenAPI metadata through the nested stats router", async () => {
  const spec = await generateSpecs(new Hono().route("/global/stats", StatsRoute()))
  expect(spec.paths?.["/global/stats/usage"]?.get?.operationId).toBe("global.stats.usage")
  expect(spec.paths?.["/global/stats/usage/records"]?.get?.operationId).toBe("global.stats.usageRecords")
  expect(spec.paths?.["/global/stats/usage/records"]?.delete?.operationId).toBe("global.stats.usageClear")
  expect(spec.paths?.["/global/stats/usage/rebuild"]?.post?.operationId).toBe("global.stats.usageRebuild")
})

test("usage API pages compact records, enforces cursor filters and validates clear scope and revision", () =>
  runtime.run(async () => {
    const scopeID = crypto.randomUUID()
    const owner = { kind: "operation" as const, scopeID, operationID: crypto.randomUUID() }
    const call = await RolloutLedger.beginCall({
      owner,
      runID: "run",
      purpose: "test",
      request: {},
      model: { providerID: "p", modelID: "m", sdk: "@ai-sdk/openai", pricing: null, billingMode: "api" },
    })
    await RolloutLedger.finishCall(owner, "run", call.id, {
      status: "completed",
      sdkUsage: { inputTokens: 10, outputTokens: 5 },
    })
    const result = await app.request(`/global/stats/usage?scopeID=${scopeID}&timezone=Asia%2FShanghai`)
    expect(result.status).toBe(200)
    const summary = await result.json()
    expect(summary.accounting.tokens.total.total).toBe(15)
    expect(summary.timezone).toBe("Asia/Shanghai")
    const page = await (await app.request(`/global/stats/usage/records?scopeID=${scopeID}&limit=1`)).json()
    expect(page.items).toHaveLength(1)
    expect(page.nextCursor).toBeString()
    const next = await (
      await app.request(`/global/stats/usage/records?scopeID=${scopeID}&limit=1&cursor=${page.nextCursor}`)
    ).json()
    expect(next.items[0].id).not.toBe(page.items[0].id)
    expect((await app.request(`/global/stats/usage/records?scopeID=wrong&cursor=${page.nextCursor}`)).status).toBe(400)
    for (const query of ["from=2&to=1", "timezone=invalid/zone", "from=nan"])
      expect((await app.request(`/global/stats/usage?${query}`)).status).toBe(400)
    expect((await app.request("/global/stats/usage/records?limit=501")).status).toBe(400)
    const clear = (scope: unknown, throughRevision: number) =>
      app.request("/global/stats/usage/records", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope, throughRevision }),
      })
    expect((await clear({}, summary.revision)).status).toBe(400)
    expect((await clear({ scopeID }, summary.revision + 100)).status).toBe(400)
    const removed = await clear({ scopeID }, summary.revision)
    expect(removed.status).toBe(200)
    expect((await removed.json()).activeRetained).toBe(1)
    expect((await app.request("/global/stats/usage/rebuild", { method: "POST" })).status).toBe(200)
  }))
