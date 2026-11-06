import { expect, test } from "bun:test"
import { Hono } from "hono"
import { generateSpecs } from "hono-openapi"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { SessionRoute } from "../../src/server/session"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { SessionTransfer } from "@ericsanchezok/synergy-harness/session/transfer"
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

test("a frozen source still serves retained history without attempting pause repair", async () => {
  await using source = await testRuntime()
  await using target = await testRuntime()
  const app = new Hono().route("/session", SessionRoute())
  const run = <T>(fn: () => Promise<T>) =>
    source.run(() => ScopeContext.provide({ scope: Scope.home(), workspace: null, fn }))
  const session = await run(async () => {
    const info = await Session.create({ workspace: null })
    const rootID = Identifier.ascending("message")
    await Session.updateMessage({
      id: rootID,
      sessionID: info.id,
      role: "user",
      isRoot: true,
      rootID,
      agent: "general",
      model: { providerID: "test", modelID: "test" },
      time: { created: 1 },
    })
    await SessionLifecycle.pause({ sessionID: info.id, reason: "interrupted" })
    return info
  })
  const destination = await target.run(() => SessionTransfer.host())
  await run(() => SessionTransfer.prepare(session.id, { targetID: destination.id, migrationID: crypto.randomUUID() }))
  await run(() =>
    Storage.current().store.transaction((tx) =>
      tx.remove([
        "sessions",
        "home",
        session.id,
        "migrations",
        "session",
        "20261010-session-pause-recovery-candidates",
      ]),
    ),
  )
  const response = await run(async () => app.request(`/session/${session.id}`))
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    id: session.id,
    transfer: { phase: "prepared" },
    paused: { reason: "interrupted" },
  })
  const messages = await run(async () => app.request(`/session/${session.id}/message`))
  expect(messages.status).toBe(200)
  await expect(run(() => SessionLifecycle.clear(session.id))).rejects.toThrow("transfer")
  expect(await run(() => SessionTransfer.archive(session.id))).toBeInstanceOf(Blob)
}, 30_000)
