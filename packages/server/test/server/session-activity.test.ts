import { afterAll, expect, test } from "bun:test"
import { Hono } from "hono"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutArtifact } from "@ericsanchezok/synergy-harness/session/rollout/artifact"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { SessionRoute } from "../../src/server/session"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())
const app = new Hono()
  .onError((error, context) => {
    if (error instanceof Storage.NotFoundError) return context.json({ error: "Not found" }, 404)
    throw error
  })
  .route("/session", SessionRoute())

test("activity routes retain captured results, bound batch input and reject foreign Scope or call identities", () =>
  runtime.run(async () => {
    await using first = await tmpdir({ git: true })
    await using other = await tmpdir({ git: true })
    const target = await ScopeContext.provide({
      scope: await first.scope(),
      fn: async () => {
        const session = await Session.create({})
        const messageID = Identifier.ascending("message")
        const rootID = Identifier.ascending("message")
        const partID = Identifier.ascending("part")
        await Session.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "assistant",
          time: { created: 1 },
          parentID: rootID,
          rootID,
          modelID: "test",
          providerID: "test",
          mode: "test",
          agent: "synergy",
          path: { cwd: first.path, root: first.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })
        const owner = { kind: "session" as const, scopeID: session.scope.id, sessionID: session.id }
        await RolloutLedger.beginSegment({ owner, runID: rootID, input: {} })
        const content = await RolloutArtifact.writeText(owner, "original")
        await Session.updatePart({
          id: partID,
          messageID,
          sessionID: session.id,
          type: "tool",
          tool: "read",
          callID: "read-call",
          activityEvidence: { kind: "file-read", content },
          state: {
            status: "completed",
            input: { filePath: "README.md" },
            output: "wrapper",
            title: "README.md",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        })
        const url = `/session/${session.id}/message/${messageID}/part/${partID}/activity`
        const response = await app.request(`${url}?callID=read-call`)
        expect(response.status).toBe(200)
        expect((await response.json()).text).toBe("original")
        expect((await app.request(`${url}?callID=another`)).status).toBe(404)
        const turns = `/session/${session.id}/turn-execution`
        const query = (rootIDs: string[]) =>
          app.request(turns, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rootIDs }),
          })
        expect((await (await query([rootID, rootID])).json()).length).toBe(1)
        expect((await query(Array(65).fill(rootID))).status).toBe(400)
        return { url, turns, rootID }
      },
    })
    await ScopeContext.provide({
      scope: await other.scope(),
      fn: async () => {
        expect((await app.request(target.url)).status).toBe(404)
        expect(
          (
            await app.request(target.turns, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ rootIDs: [target.rootID] }),
            })
          ).status,
        ).toBe(404)
      },
    })
  }))
