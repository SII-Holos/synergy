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
  expect(session.workspace?.path).toBe(directory)
  expect((await client.scope.current()).data.id).toBe(session.scope.id)
  expect((await client.session.list()).data.data.some((item) => item.id === session.id)).toBe(true)
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
