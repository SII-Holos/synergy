import { expect, test } from "bun:test"
import { Hono } from "hono"
import { generateSpecs } from "hono-openapi"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { SessionTransferRoute } from "../../src/server/session-transfer"
import { testRuntime } from "../support/runtime"

test("mounted migration operations retain their OpenAPI metadata", async () => {
  const spec = await generateSpecs(new Hono().route("/session-transfer", SessionTransferRoute()))
  const operations = Object.values(spec.paths ?? {}).flatMap((path) =>
    Object.values(path ?? {}).flatMap((operation) =>
      typeof operation === "object" && operation && "operationId" in operation ? [operation.operationId] : [],
    ),
  )
  expect(operations).toContain("sessionTransfer.prepare")
  expect(operations).toContain("sessionTransfer.stage")
  expect(operations).toContain("sessionTransfer.activate")
})

test("HTTP stages and activates across two isolated Runtime owners", async () => {
  await using source = await testRuntime()
  await using target = await testRuntime()
  const app = new Hono().route("/session-transfer", SessionTransferRoute())
  const run = <T>(runtime: typeof source, fn: () => Promise<T>) =>
    runtime.run(() => ScopeContext.provide({ scope: Scope.home(), workspace: null, fn }))
  const call = (runtime: typeof source, url: string, body?: unknown) =>
    run(runtime, async () =>
      app.request(
        url,
        body === undefined
          ? undefined
          : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      ),
    )
  const session = await run(source, async () => {
    const info = await Session.create({ workspace: null })
    await SessionLifecycle.pause({ sessionID: info.id, reason: "interrupted" })
    return info
  })
  const host = await (await call(target, "/session-transfer/host")).json()
  const prepared = await call(source, `/session-transfer/${session.id}/prepare`, {
    migrationID: crypto.randomUUID(),
    targetID: host.id,
  })
  expect(prepared.status).toBe(200)
  const payload = await (await call(source, `/session-transfer/${session.id}/archive`)).blob()
  const form = new FormData()
  form.set("file", new File([payload], "session.zip"))
  const stage = await run(target, async () => app.request("/session-transfer/stage", { method: "POST", body: form }))
  expect(stage.status).toBe(200)
  const commit = await call(source, `/session-transfer/${session.id}/commit`, await stage.json())
  expect(commit.status).toBe(200)
  const activated = await call(target, "/session-transfer/activate", await commit.json())
  expect(activated.status).toBe(200)
  expect((await run(target, () => Session.get(session.id))).paused).toBeDefined()
  expect((await call(source, `/session-transfer/${session.id}/cancel`, {})).status).toBe(409)
}, 30_000)
