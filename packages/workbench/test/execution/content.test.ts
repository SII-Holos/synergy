import { afterAll, expect, test } from "bun:test"
import { Hono } from "hono"
import { generateSpecs } from "hono-openapi"
import { testRuntime } from "../support/runtime"
import { fixture } from "@ericsanchezok/synergy-harness/test/support/rollout"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { ExecutionRoute } from "../../src/execution/routes"
import { ExecutionService } from "../../src/execution/service"
import { ExecutionSchema } from "../../src/execution/schema"
import { ExecutionContent } from "../../src/execution/content"

const runtime = await testRuntime()
afterAll(() => runtime.close())
const app = new Hono().route("/session", ExecutionRoute())

test("section, search and download routes have distinct generated operations", async () => {
  const spec = await generateSpecs(app)
  for (const [path, name] of [
    ["sections", "Sections"],
    ["search", "Search"],
    ["download", "Download"],
  ])
    expect(spec.paths?.["/session/{sessionID}/execution/nodes/{nodeID}/content/" + path]?.get?.operationId).toBe(
      "session.executionContent" + name,
    )
})

test(
  "complete content can be read, searched beyond the first chunk and downloaded at one version",
  () =>
    runtime.run(() =>
      fixture(async ({ call, session }) => {
        const request = {
          messages: [{ role: "user", content: "中文".repeat(3_500_000) + "needle-only-at-end" }],
          tools: [{ name: "read", parameters: {} }],
        }
        const model = await RolloutLedger.beginCall({
          owner: call.owner,
          runID: call.runID,
          purpose: "large request",
          model: call.model,
          request,
        })
        const page = await ExecutionService.trajectory(session.id, ExecutionSchema.Query.parse({ kind: "model" }))
        const node = page.items.find((item) => item.callID === model.id)!
        const prefix = "/session/" + session.id + "/execution/nodes/" + node.id + "/content"
        const first = await (await app.request(prefix + "?field=request")).json()
        const params = "?field=request&version=" + encodeURIComponent(first.contentVersion)
        const sections = await (await app.request(prefix + "/sections" + params)).json()
        expect(sections.format).toBe("json")
        expect(sections.items.find((item: { role?: string }) => item.role === "user")).toBeDefined()
        const search = await (await app.request(prefix + "/search" + params + "&query=needle-only-at-end")).json()
        expect(search.items[0].offset).toBeGreaterThan(65_536)
        const downloaded = await app.request(prefix + "/download" + params)
        expect(downloaded.headers.get("x-execution-content-version")).toBe(first.contentVersion)
        expect(JSON.parse(await downloaded.text())).toEqual(request)
        expect((await app.request(prefix + "/download?field=credentials")).status).toBe(404)
        expect((await app.request(prefix + "/search" + params + "&query=x&limit=501")).status).toBe(400)
        const invalidVersion = Buffer.from(
          JSON.stringify({
            id: "another-artifact",
            mediaType: "application/json",
            bytes: 1,
            chunks: 1,
            status: "complete",
            sha256: "no",
          }),
        ).toString("base64url")
        expect((await app.request(prefix + "/download?field=request&version=" + invalidVersion)).status).toBe(400)
      }),
    ),
  30_000,
)

test("content search treats special characters literally and paginates UTF-8 boundary matches", async () => {
  const value = Buffer.from("x".repeat(65_533) + "中文[.] 😀 中文[.] 😀 中文[.]")
  const source: ExecutionContent.Source = {
    contentVersion: "pinned",
    mediaType: "text/plain",
    bytes: value.length,
    sha256: null,
    status: "complete",
    stream: async function* () {
      yield value
    },
    read: async (offset, limit) => {
      let end = Math.min(value.length, offset + limit)
      while (end < value.length && (value[end] & 0xc0) === 0x80) end--
      return {
        contentVersion: "pinned",
        mediaType: "text/plain",
        bytes: value.length,
        sha256: null,
        status: "complete",
        text: value.subarray(offset, end).toString(),
        offset,
        nextOffset: end < value.length ? end : null,
      }
    },
  }
  const input = ExecutionContent.SearchQuery.parse({ field: "stream", query: "中文[.]", limit: 1 })
  const matches = []
  let cursor: string | undefined
  do {
    const result = await ExecutionContent.search(source, { ...input, cursor })
    matches.push(...result.items)
    cursor = result.nextCursor ?? undefined
  } while (cursor)
  expect(matches.map((match) => match.offset)).toEqual([65_533, 65_548, 65_563])
  expect(matches.every((match) => match.bytes === Buffer.byteLength(input.query))).toBe(true)
  const abort = new AbortController()
  abort.abort()
  await expect(ExecutionContent.search(source, input, abort.signal)).rejects.toThrow()
})
