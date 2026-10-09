import { afterAll, expect, test } from "bun:test"
import { Hono } from "hono"
import { generateSpecs } from "hono-openapi"
import { testRuntime } from "../support/runtime"
import { fixture, complete } from "@ericsanchezok/synergy-harness/test/support/rollout"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { ExecutionRoute } from "../../src/execution/routes"

const runtime = await testRuntime()
afterAll(() => runtime.close())
const app = new Hono().route("/session", ExecutionRoute())

test("context routes have distinct generated operations", async () => {
  const spec = await generateSpecs(app)
  for (const [path, operation] of [
    ["history", "executionContextHistory"],
    ["snapshots/{callID}", "executionContextSnapshot"],
    ["snapshots/{callID}/items", "executionContextItems"],
  ])
    expect(spec.paths?.["/session/{sessionID}/execution/context/" + path]?.get?.operationId).toBe(
      "session." + operation,
    )
})

test("context history pages only main conversation requests and reads bounded source metadata", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      const created = []
      for (let index = 0; index < 3; index++) {
        const next = await RolloutLedger.beginCall({
          owner: call.owner,
          runID: rootID,
          purpose: "general",
          usageRole: "conversation",
          model: call.model,
          request: {
            messages: [{ role: "user", content: "fixture content" }],
            contextSources: [
              {
                category: "userMessages",
                path: ["messages", "0"],
                selector: ["content"],
                source: "userMessages",
                characters: 15,
                precision: "source",
              },
            ],
          },
        })
        await complete(next, { inputTokens: index + 10 })
        created.push(next)
      }
      const base = "/session/" + session.id + "/execution/context/"
      const response = await app.request(base + "history?limit=2")
      expect(response.status).toBe(200)
      const page = await response.json()
      expect(page.total).toBe(3)
      expect(page.items.map((item: { callID: string }) => item.callID)).toEqual(
        created
          .slice(1)
          .reverse()
          .map((item) => item.id),
      )
      expect(page.items[0].usage).toBeNull()
      expect(page.items[0].inputTokens).toBe(12)
      const older = await (
        await app.request(base + "history?limit=2&cursor=" + encodeURIComponent(page.nextCursor))
      ).json()
      expect(older.items.map((item: { callID: string }) => item.callID)).toEqual([created[0].id])
      const items = await (
        await app.request(base + "snapshots/" + created[0].id + "/items?category=userMessages")
      ).json()
      expect(items.items).toHaveLength(1)
      expect(items.items[0]).toMatchObject({ source: "userMessages", selector: ["content"], characters: 15 })
      expect(items.items[0].bytes).toBeGreaterThan(0)
      expect(JSON.stringify(items)).not.toContain("fixture content")
      expect((await app.request(base + "snapshots/" + call.id)).status).toBe(404)
      expect((await app.request(base + "history?limit=501")).status).toBe(400)
      expect((await app.request(base + "snapshots/" + created[0].id + "/items?version=wrong")).status).toBe(400)
    }),
  ))

test(
  "large context evidence keeps source metadata reachable without returning prompt bodies",
  () =>
    runtime.run(() =>
      fixture(async ({ session, rootID, call }) => {
        const entries = Array.from({ length: 12_050 }, (_, index) => ({
          role: "user",
          content: `source-${index}:` + "x".repeat(1024),
        }))
        const sources = entries.map((entry, index) => ({
          category: "userMessages",
          path: ["messages", String(index)],
          selector: ["content"],
          source: `source-${index}`,
          characters: entry.content.length,
          precision: "source",
        }))
        const next = await RolloutLedger.beginCall({
          owner: call.owner,
          runID: rootID,
          purpose: "general",
          usageRole: "conversation",
          model: call.model,
          request: { messages: entries, contextSources: sources },
        })
        await complete(next)
        const base = `/session/${session.id}/execution/context/snapshots/${next.id}/items`
        const response = await app.request(base + "?limit=30")
        expect(response.status).toBe(200)
        const page = await response.json()
        expect(page.status).toBe("available")
        expect(page.items).toHaveLength(30)
        expect(page.total).toBeLessThanOrEqual(10_000)
        expect(page.truncated).toBe(true)
        expect(JSON.stringify(page)).not.toContain("x".repeat(256))
        const older = await (await app.request(base + "?limit=30&cursor=" + encodeURIComponent(page.nextCursor))).json()
        expect(older.items[0].id).not.toBe(page.items[0].id)
        expect(
          (await app.request(base + "?query=different&cursor=" + encodeURIComponent(page.nextCursor))).status,
        ).toBe(400)
      }),
    ),
  30_000,
)
