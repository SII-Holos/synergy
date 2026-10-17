import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { SessionEvent } from "@ericsanchezok/synergy-harness/session/event"
import { createLocalClient, openLocalRuntime } from "../src"

test("in-process client creates and lists sessions in its explicit Scope", async () => {
  await using fixture = await runtimeHome()
  await using runtime = await openLocalRuntime({ host: fixture.host, mode: "oneshot" })
  const directory = path.join(fixture.host.home, "project")
  await fs.mkdir(directory)
  const client = createLocalClient(runtime, { directory })
  const { data: session } = await client.session.create({ title: "Research session", workspace: { mode: "current" } })
  expect(session.title).toBe("Research session")
  expect(session.workspace?.path).toBe(await fs.realpath(directory))
  expect((await client.scope.current()).data.id).toBe(session.scope.id)
  expect((await client.session.list()).data.data.some((item) => item.id === session.id)).toBe(true)
})

test("in-process Home clients use the managed default and preserve an explicit empty selection", async () => {
  await using fixture = await runtimeHome()
  await using runtime = await openLocalRuntime({ host: fixture.host, mode: "oneshot" })
  const client = createLocalClient(runtime, { scopeID: "home" })
  const { data: session } = await client.session.create({ workspace: { mode: "current" } })
  expect(session.scope).toEqual({ type: "home", id: "home", local: null })
  expect(session.workspace?.path).toBe(await fs.realpath(path.join(fixture.host.root, "workspaces", "home")))
  const { data: empty } = await client.session.create({ workspace: { mode: "none" } })
  expect(empty.workspace).toBeNull()
  expect(empty.workspaceID).toBeNull()
})

for (const close of ["caller", "runtime"] as const) {
  test(`in-process event stream closes a pending read when ${close} aborts`, async () => {
    await using fixture = await runtimeHome()
    await using runtime = await openLocalRuntime({ host: fixture.host, mode: "oneshot" })
    const controller = new AbortController()
    const { stream } = await createLocalClient(runtime, { scopeID: "home" }).event.subscribe(
      {},
      { signal: controller.signal },
    )
    const next = stream.next()
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: () => Bus.publish(SessionEvent.Error, { sessionID: "ses_probe", error: { message: "probe" } }),
      }),
    )
    expect((await next).value).toEqual({
      type: "session.error",
      properties: { sessionID: "ses_probe", error: { message: "probe" } },
    })
    const pending = stream.next()
    if (close === "runtime") await runtime.close()
    else controller.abort()
    expect((await pending).done).toBe(true)
  })
}
