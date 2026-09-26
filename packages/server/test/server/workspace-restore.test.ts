import { afterAll, expect, test } from "bun:test"
import path from "node:path"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { Snapshot } from "@ericsanchezok/synergy-harness/session/snapshot"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Server } from "../../src/server/server"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

async function captured() {
  const session = await Session.create({})
  const file = path.join(ScopeContext.current.directory, "note.txt")
  await Bun.write(file, "original")
  const hash = (await Snapshot.track(session.id))!
  await Bun.write(file, "edited")
  const userID = Identifier.ascending("message"),
    assistantID = Identifier.ascending("message"),
    partID = Identifier.ascending("part")
  await Session.updateMessage({
    id: userID,
    sessionID: session.id,
    role: "user",
    time: { created: 1 },
    agent: "synergy",
    model: { providerID: "test", modelID: "test" },
  })
  await Session.updateMessage({
    id: assistantID,
    sessionID: session.id,
    role: "assistant",
    parentID: userID,
    time: { created: 2, completed: 3 },
    modelID: "test",
    providerID: "test",
    mode: "build",
    agent: "synergy",
    path: { cwd: ScopeContext.current.directory, root: ScopeContext.current.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  await Session.updatePart({
    id: partID,
    sessionID: session.id,
    messageID: assistantID,
    type: "patch",
    hash,
    workspace: Snapshot.workspace(),
    files: [file],
  })
  const request = (scopeID = session.scope.id) =>
    Server.App().request(`/session/${session.id}/files/restore?scopeID=${scopeID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ partID }),
    })
  return { session, file, request }
}

test("restore API reports actual native results and refuses another Scope", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    await using other = await tmpdir()
    const foreign = await other.scope()
    await ScopeContext.provide({
      scope: await directory.scope(),
      fn: async () => {
        const { session, file, request } = await captured()
        try {
          const denied = await request(foreign.id)
          expect(denied.status).toBe(404)
          expect(await Bun.file(file).text()).toBe("edited")
          const response = await request()
          expect(response.status).toBe(200)
          expect(await response.json()).toMatchObject({ restoredFiles: [file], failedFiles: [] })
          expect(await Bun.file(file).text()).toBe("original")
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  }))

test("restore API returns a conflict while the session is occupied or its binding changed", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    await using other = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      fn: async () => {
        const { session, file, request } = await captured()
        try {
          const lease = SessionManager.acquire(session.id)!
          try {
            expect((await request()).status).toBe(409)
          } finally {
            await SessionManager.finish(lease, { requestNextWork: false })
          }
          const record = await WorkspaceCatalog.get(session.workspaceID!, session.scope.id)
          await WorkspaceBinding.rebind(record.id, {
            scopeID: session.scope.id,
            expectedRevision: record.revision,
            path: other.path,
          })
          const response = await request()
          expect(response.status).toBe(409)
          expect(await response.json()).toMatchObject({ name: "WorkspaceBindingChanged" })
          expect(await Bun.file(file).text()).toBe("edited")
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  }))
