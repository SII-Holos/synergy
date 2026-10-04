import { afterAll, expect, test } from "bun:test"
import { Hono } from "hono"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Snapshot } from "@ericsanchezok/synergy-harness/session/snapshot"
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

test("file history routes require confirmed previews, preserve conflicts and enforce Scope ownership", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    await using other = await tmpdir()
    const sessionID = await ScopeContext.provide({
      scope: await directory.scope(),
      fn: async () => {
        const session = await Session.create({})
        const file = `${directory.path}/note.txt`
        await Bun.write(file, "baseline\n")
        const from = await Snapshot.track(session.id)
        await Bun.write(file, "recorded\n")
        const to = await Snapshot.track(session.id)
        const root = await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          isRoot: true,
          agent: "synergy",
          model: { providerID: "test", modelID: "test" },
          time: { created: Date.now() },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: root.id,
          type: "patch",
          hash: from!,
          files: ["note.txt"],
          workspace: Snapshot.workspace(),
          checkpoint: {
            version: 1,
            rootID: root.id,
            segmentID: "test",
            started: 1,
            ended: 2,
            status: "complete",
            afterHash: to!,
          },
        })
        const post = (action: string, body: unknown) =>
          app.request(`/session/${session.id}/files/${action}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        expect((await post("restore", { messageID: root.id })).status).toBe(400)
        const preview = await post("preview", { messageID: root.id })
        expect(preview.status).toBe(200)
        const data = (await preview.json()) as { id: string; files: { before: string; after: string }[] }
        expect(data.files[0]).toMatchObject({ before: "recorded\n", after: "baseline\n" })
        await Bun.write(file, "newer\n")
        const restored = await post("restore", { previewID: data.id })
        expect(restored.status).toBe(200)
        const result = await restored.json()
        expect(result).toMatchObject({ restoredFiles: [], failedFiles: [{ code: "conflict" }] })
        expect(await Bun.file(file).text()).toBe("newer\n")
        expect(await (await post("restore", { previewID: data.id })).json()).toEqual(result)
        const workspace = Snapshot.workspace()!
        const query = new URLSearchParams({
          workspaceID: workspace.id,
          generation: String(workspace.generation),
          file: "note.txt",
          messageID: root.id,
        })
        const diff = await app.request(`/session/${session.id}/files/diff?${query}`)
        expect(diff.status).toBe(200)
        expect(((await diff.json()) as { patch: string }).patch).toContain("+recorded")
        return session.id
      },
    })
    await ScopeContext.provide({
      scope: await other.scope(),
      fn: async () => {
        expect(
          (
            await app.request(`/session/${sessionID}/files/preview`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{}",
            })
          ).status,
        ).toBe(404)
      },
    })
  }))
