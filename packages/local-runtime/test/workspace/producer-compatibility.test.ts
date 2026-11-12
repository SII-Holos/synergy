import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { BlobReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { SessionTransfer } from "@ericsanchezok/synergy-harness/session/transfer"
import { WorkspaceBinding } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceTree } from "@ericsanchezok/synergy-harness/workspace/tree"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "../support/runtime"

test("the separately registered public version-one Session export retains its declared native Workspace wire format", async () => {
  await using temporary = await tmpdir()
  const directory = path.join(temporary.path, "native")
  await fs.mkdir(directory)
  const data = new Uint8Array([0, 255, 7])
  await Bun.write(path.join(directory, "file"), data)
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const workspace = await WorkspaceBinding.register("home", directory)
        const session = await Session.create({ workspaceID: workspace.id, environmentID: null })
        await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
        const state = await SessionTransfer.prepare(session.id, {
          migrationID: crypto.randomUUID(),
          targetID: crypto.randomUUID(),
        })
        expect(state.phase).toBe("prepared")
        const reader = new ZipReader(new BlobReader(await SessionTransfer.archive(session.id)), {
          checkSignature: true,
          useWebWorkers: false,
        })
        try {
          const entries = await reader.getEntries()
          const descriptor = entries.find((entry) => entry.filename === "manifest.json")
          if (!descriptor || descriptor.directory) throw new Error("Version-one export omitted its manifest")
          const manifest = z
            .object({
              version: z.literal(1),
              workspace: z.object({
                tree: WorkspaceTree.Manifest,
                chunks: z.array(z.object({ hash: WorkspaceTree.Hash, file: z.string() })),
              }),
            })
            .parse(JSON.parse(new TextDecoder().decode(await descriptor.getData(new Uint8ArrayWriter()))))
          expect(manifest.version).toBe(1)
          const tree = manifest.workspace.tree
          expect(tree.entries).toHaveLength(1)
          const entry = tree.entries[0]!
          if (entry.kind !== "file") throw new Error("Version-one export omitted its captured file")
          expect(entry.hash).toBe(WorkspaceTree.hash(data))
          const chunk = manifest.workspace.chunks.find((chunk) => chunk.hash === entry.chunks[0]!.hash)
          const object = entries.find((entry) => entry.filename === chunk?.file)
          if (!object || object.directory) throw new Error("Version-one export omitted its chunk frame")
          expect(await object.getData(new Uint8ArrayWriter())).toEqual(data)
        } finally {
          await reader.close()
        }
      },
    }),
  )
})
