import { afterAll, expect, test } from "bun:test"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"
import { WorkingInfo } from "../../src/session/types"
import { resolve, toStatus } from "../../src/session/working"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("activity snapshots retain the real phase and reject obsolete root, lease and stopping updates", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Activity" })
        const first = SessionManager.acquire(session.id)!
        SessionManager.bindRootTask(first, "root-1")
        const owner = { generation: first.generation, rootID: "root-1" }
        expect(SessionManager.setActivity(session.id, { phase: "preparing_files" }, owner)).toBe(true)
        const initial = (await SessionManager.listStatuses())[session.id]
        expect(initial).toMatchObject({ type: "busy", activity: { phase: "preparing_files", rootID: "root-1" } })
        expect(SessionManager.setActivity(session.id, { phase: "preparing_files" }, owner)).toBe(true)
        expect((await SessionManager.listStatuses())[session.id]).toEqual(initial)
        expect(
          SessionManager.setActivity(session.id, { phase: "running_tools", tool: { id: "read", count: 2 } }, owner),
        ).toBe(true)
        expect((await SessionManager.listStatuses())[session.id]).toMatchObject({
          type: "busy",
          activity: { phase: "running_tools", tool: { id: "read", count: 2 } },
        })
        const working = WorkingInfo.parse(await resolve(session.id))
        expect(working).toMatchObject({
          status: "busy",
          activity: { phase: "running_tools", rootID: "root-1", tool: { id: "read", count: 2 } },
        })
        expect(toStatus(working)).toEqual((await SessionManager.listStatuses())[session.id])
        SessionManager.bindRootTask(first, "root-2")
        expect(SessionManager.setActivity(session.id, { phase: "responding" }, owner)).toBe(false)
        SessionManager.signalAbort(session.id)
        expect(SessionManager.setActivity(session.id, { phase: "waiting_model" }, { ...owner, rootID: "root-2" })).toBe(
          false,
        )
        expect((await SessionManager.listStatuses())[session.id]).toMatchObject({
          type: "busy",
          activity: { phase: "stopping" },
        })
        await SessionManager.release(first, { requestNextWork: false })
        const second = SessionManager.acquire(session.id)!
        SessionManager.bindRootTask(second, "root-3")
        expect(SessionManager.setActivity(session.id, { phase: "responding" }, owner)).toBe(false)
        expect(
          SessionManager.setActivity(
            session.id,
            { phase: "waiting_model" },
            { generation: second.generation, rootID: "root-3" },
          ),
        ).toBe(true)
        await SessionManager.release(second, { requestNextWork: false })
        expect(
          SessionManager.setActivity(
            session.id,
            { phase: "responding" },
            { generation: second.generation, rootID: "root-3" },
          ),
        ).toBe(false)
        expect((await SessionManager.listStatuses())[session.id]).toBeUndefined()
        await Session.remove(session.id)
      },
    })
  }))
