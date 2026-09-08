import { expect, test } from "bun:test"
import { Hono } from "hono"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionRoute } from "../../src/server/session"
import { SessionExportRoute } from "../../src/server/session-export"

const app = new Hono().route("/session", SessionRoute).route("/session", SessionExportRoute)
const json = (method: string, body: unknown) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
})

test("core HTTP sessions support listing, fork, file export and import without product domains", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const create = await app.request("/session", json("POST", { title: "Route research fixture" }))
      expect(create.status).toBe(200)
      const session = (await create.json()) as Session.Info
      expect((await (await app.request(`/session/${session.id}`)).json()).id).toBe(session.id)
      const list = await (await app.request("/session?search=Route%20research&limit=2&offset=0")).json()
      expect(list.data.map((item: Session.Info) => item.id)).toEqual([session.id])
      expect(list.total).toBe(1)
      expect((await app.request("/session/status")).status).toBe(200)
      for (const resource of ["children", "todo", "dag", "message", "diff"]) {
        const response = await app.request(`/session/${session.id}/${resource}`)
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual(resource === "children" ? { items: [], nextCursor: null, total: 0 } : [])
      }
      expect((await app.request(`/session/${session.id}/message/page?limit=1`)).status).toBe(200)
      const invalidCursor = await app.request(`/session/${session.id}/message/page?cursor=invalid`)
      expect(invalidCursor.status).toBe(400)
      const forkResponse = await app.request(`/session/${session.id}/fork`, json("POST", {}))
      expect(forkResponse.status).toBe(200)
      const fork = (await forkResponse.json()) as Session.Info
      expect(fork.id).not.toBe(session.id)
      const updated = await app.request(
        `/session/${session.id}`,
        json("PATCH", { title: "Renamed research fixture", pinned: 1 }),
      )
      expect(updated.status).toBe(200)
      expect((await updated.json()).title).toBe("Renamed research fixture")
      expect((await app.request(`/session/${session.id}/export/estimate`)).status).toBe(200)
      const download = await app.request(`/session/${session.id}/export`)
      expect(download.headers.get("content-type")).toContain("application/gzip")
      const data = new Uint8Array(await download.arrayBuffer())
      const report = JSON.parse(Buffer.from(Bun.gunzipSync(data)).toString())
      expect(report.rootSessionID).toBe(session.id)
      expect((await app.request(`/session/${session.id}/export?run=invalid`)).status).toBe(400)
      const form = new FormData()
      form.set("file", new File([data], "session.json.gz", { type: "application/gzip" }))
      const imported = await app.request("/session/import", { method: "POST", body: form })
      expect(imported.status).toBe(200)
      const importedInfo = (await imported.json()) as { rootSessionID: string; sessionCount: number }
      expect(importedInfo.sessionCount).toBe(1)
      expect((await Session.get(importedInfo.rootSessionID)).title).toContain("Renamed research fixture")
      const malformed = new FormData()
      malformed.set("file", new File(["not json"], "broken.json"))
      expect((await app.request("/session/import", { method: "POST", body: malformed })).status).toBe(400)
      const missing = new FormData()
      missing.set("file", "not a file")
      expect((await app.request("/session/import", { method: "POST", body: missing })).status).toBe(400)
      expect((await app.request(`/session/${session.id}/abort`, { method: "POST" })).status).toBe(200)
      for (const id of [session.id, fork.id, importedInfo.rootSessionID])
        expect((await app.request(`/session/${id}`, { method: "DELETE" })).status).toBe(200)
      expect((await Session.list()).data).toEqual([])
    },
  })
})
