import { expect, test } from "bun:test"
import { z } from "zod"
import fs from "node:fs/promises"
import path from "node:path"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionWorkspaceRuntime } from "../../src/session/workspace-runtime"
import { Storage } from "../../src/storage/storage"
import { WorkspaceCatalog } from "../../src/workspace/catalog"
import { WorkspaceFileSource } from "../../src/workspace/file-source"
import { testRuntime } from "../support/runtime"

test("Session remote binding consumes its actual Catalog and installed synchronous file owner at publication", async () => {
  let opens = 0
  let changedSession: string | undefined
  const spec = z.strictObject({ version: z.literal(1), root: z.literal("owned-files") })
  const home = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "file-source-binding-"))
  const register = () => {
    WorkspaceFileSource.register("binding-fixture", {
      inspectBinding(workspace) {
        spec.parse(workspace.backend?.spec)
        return undefined
      },
      async open() {
        opens++
        throw new Error("Binding inspection cannot acquire file access")
      },
    })
    SessionWorkspaceRuntime.registerTransition("replace-remote-binding", async (session) => {
      if (session.id !== changedSession) return
      const current = await WorkspaceCatalog.get("wsp_remote", "home")
      await Storage.write(["workspace", current.id], {
        ...current,
        revision: current.revision + 1,
        binding: { ...current.binding, generation: current.binding.generation + 1 },
      })
    })
  }
  try {
    await using runtime = await testRuntime({ home, composition: { register } })
    const sessionID = await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const record = WorkspaceCatalog.Info.parse({
            id: "wsp_remote",
            scopeID: "home",
            type: "directory",
            revision: 1,
            binding: { state: "bound", hostID: "binding-fixture", path: null, generation: 1 },
            backend: { provider: "binding-fixture", spec: { version: 1, root: "owned-files" } },
            metadata: {},
            sharedWritableWorkspaceIDs: [],
            lifecycle: "active",
            createdAt: 1,
            updatedAt: 1,
          })
          await Storage.transaction((tx) => WorkspaceCatalog.writeImportedFiles(record, tx))
          const session = await Session.create({ workspaceID: null, environmentID: null })
          const bound = await Session.updateWorkspace(session.id, null, {
            reference: { workspaceID: record.id, workspaceGeneration: 1 },
          })
          expect(bound.workspaceID).toBe(record.id)
          expect(bound.workspace).toBeNull()
          expect(opens).toBe(0)
          await Session.update(session.id, (draft) => {
            draft.title = "Remote files"
            draft.time.archived = Date.now()
          })
          expect((await Session.get(session.id)).workspaceID).toBe(record.id)
          expect((await Session.readPageIndex("home")).entries.find((entry) => entry.id === session.id)?.archived).toBe(
            true,
          )
          await Session.update(session.id, (draft) => {
            draft.time.archived = undefined
          })
          expect((await Session.get(session.id)).workspace).toBeNull()
          const unknown = { ...record, id: "wsp_unknown", backend: { provider: "not-installed", spec: {} } }
          await Storage.transaction((tx) => WorkspaceCatalog.writeImportedFiles(unknown, tx))
          await expect(
            Session.updateWorkspace(session.id, null, {
              reference: { workspaceID: unknown.id, workspaceGeneration: 1 },
            }),
          ).rejects.toThrow("installed binding inspection owner")
          expect((await Session.get(session.id)).workspaceID).toBe(record.id)
          const malformed = {
            ...record,
            id: "wsp_malformed",
            backend: { provider: "binding-fixture", spec: { version: 1, root: "another-owner" } },
          }
          await Storage.transaction((tx) => WorkspaceCatalog.writeImportedFiles(malformed, tx))
          await expect(
            Session.updateWorkspace(session.id, null, {
              reference: { workspaceID: malformed.id, workspaceGeneration: 1 },
            }),
          ).rejects.toThrow()
          const racing = await Session.create({ workspaceID: null, environmentID: null })
          changedSession = racing.id
          await expect(
            Session.updateWorkspace(racing.id, null, {
              reference: { workspaceID: record.id, workspaceGeneration: 1 },
            }),
          ).rejects.toThrow()
          expect((await Session.get(racing.id)).workspaceID).toBeNull()
          expect((await WorkspaceCatalog.get(record.id, "home")).binding.generation).toBe(2)
          expect(opens).toBe(0)
          return session.id
        },
      }),
    )
    await runtime.close()
    await using cold = await testRuntime({ home, composition: { register } })
    await cold.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const retained = await Session.get(sessionID)
          expect(retained.workspaceID).toBe("wsp_remote")
          expect(retained.workspace).toBeNull()
          expect(retained.title).toBe("Remote files")
          expect(retained.time.archived).toBeUndefined()
          expect((await Session.readPageIndex("home")).entries.find((entry) => entry.id === sessionID)?.archived).toBe(
            false,
          )
          await Session.assertWorkspaceAvailable(sessionID)
          expect(opens).toBe(0)
        },
      }),
    )
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})
