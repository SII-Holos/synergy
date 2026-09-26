import { expect, test } from "bun:test"
import { Hono } from "hono"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { PermissionRoute } from "../../src/server/permission"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

const app = new Hono().route("/", PermissionRoute())

function askPermission(input: { id: string; sessionID: string }) {
  const pending = PermissionNext.ask({
    id: input.id,
    sessionID: input.sessionID,
    permission: "bash",
    patterns: ["ls"],
    metadata: {},
    ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
  })
  pending.catch(() => {})
  return pending
}

test("listing permissions filters by sessionID and stays complete without the filter", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const sessionA = "ses_permission_filter_a"
        const sessionB = "ses_permission_filter_b"
        askPermission({ id: "permission_filter_a", sessionID: sessionA })
        askPermission({ id: "permission_filter_b", sessionID: sessionB })

        const all = await app.request("/permission")
        expect(all.status).toBe(200)
        const allRequests = (await all.json()) as PermissionNext.Request[]
        expect(allRequests.map((request) => request.id).sort()).toEqual(["permission_filter_a", "permission_filter_b"])

        const filtered = await app.request(`/permission?sessionID=${sessionA}`)
        expect(filtered.status).toBe(200)
        const filteredRequests = (await filtered.json()) as PermissionNext.Request[]
        expect(filteredRequests.map((request) => request.id)).toEqual(["permission_filter_a"])
        expect(filteredRequests.every((request) => request.sessionID === sessionA)).toBe(true)

        const other = await app.request(`/permission?sessionID=${sessionB}`)
        expect(((await other.json()) as PermissionNext.Request[]).map((request) => request.id)).toEqual([
          "permission_filter_b",
        ])

        const missing = await app.request("/permission?sessionID=ses_permission_filter_missing")
        expect(missing.status).toBe(200)
        expect(await missing.json()).toEqual([])

        await PermissionNext.reply({ requestID: "permission_filter_a", reply: "once" })
        await PermissionNext.reply({ requestID: "permission_filter_b", reply: "once" })
      },
    })
  }))

afterRuntimeTests(() => runtime.close())
