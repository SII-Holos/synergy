import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { testEnvironmentRuntime } from "@ericsanchezok/synergy-harness/test/support/environment-origin"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceBlobs, WorkspaceContent, type BlobStore } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceMounts } from "@ericsanchezok/synergy-harness/workspace/mount"
import { WorkspaceTree } from "@ericsanchezok/synergy-harness/workspace/tree"
import { WorkspacePortableTree } from "@ericsanchezok/synergy-harness/workspace/portable-tree"
import { SessionTransferStream } from "@ericsanchezok/synergy-harness/session/transfer"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"
import { registerNativeEnvironment } from "../../src/environment/native"

test("native attachment copies a complete paged saved head and saves independently after object loss", async () => {
  await using directory = await tmpdir()
  const objects = path.join(directory.path, "objects")
  const store: BlobStore = {
    async put(hash, bytes) {
      await fs.mkdir(objects, { recursive: true })
      await fs.writeFile(path.join(objects, hash), bytes)
    },
    get(hash) {
      return fs.readFile(path.join(objects, hash))
    },
  }
  const coordinator = new WorkspaceCoordinator({ directory: path.join(directory.path, "claims") })
  await using runtime = await testEnvironmentRuntime({
    register() {
      WorkspaceAccess.register(coordinator)
      registerNativeEnvironment({ coordinator })
      WorkspaceBlobs.register("paged-mount", store)
    },
  })
  await runtime.run(async () => {
    const root: WorkspacePortableTree.Root = {
      version: 1,
      mode: 0o750,
      tree: await SessionTransferStream.write({
        store,
        owners: { "workspace-files": 1 },
        entries: (async function* () {
          for (let ordinal = 0; ordinal < 260; ordinal++)
            yield {
              id: `file-${ordinal}`,
              kind: "file" as const,
              metadata: { version: 1, kind: "file", mode: 0o640 },
              content: (async function* () {
                yield new Uint8Array([0, 255, ordinal % 251])
              })(),
            }
        })(),
      }),
    }
    expect(root.tree.pages).toBeGreaterThan(1)
    const bytes = new TextEncoder().encode(JSON.stringify(root))
    const manifest = WorkspaceTree.hash(bytes)
    await store.put(manifest, bytes)
    const scope = await directory.scope()
    let workspace = await WorkspaceCatalog.create({
      scopeID: scope.id,
      backend: { provider: "objects", spec: { blobStore: "paged-mount" } },
    })
    workspace = await WorkspaceCatalog.publishContent(workspace, manifest)
    const environment = await Environment.bind({ scopeID: scope.id, ownerID: "fixture", provider: "native", spec: {} })
    expect((await Environment.get(environment.id, scope.id)).state).toBe("idle")
    const mounted = await WorkspaceMounts.attach({
      workspaceID: workspace.id,
      scopeID: scope.id,
      environmentID: environment.id,
      generation: workspace.binding.generation,
    })
    expect(mounted.activeMount?.state).toBe("active")
    const files = await WorkspaceMounts.connect(mounted)
    const reference = WorkspaceMounts.reference(mounted)
    await fs.rm(objects, { recursive: true })
    expect((await files.read({ mount: reference, path: "file-259", maximumBytes: 16 })).data).toBe(
      Buffer.from([0, 255, 259 % 251]).toString("base64"),
    )
    const detached = await WorkspaceMounts.detach({ workspaceID: workspace.id, scopeID: scope.id })
    expect(detached.activeMount).toBeUndefined()
    expect(await WorkspaceContent.read({ workspaceID: workspace.id, scopeID: scope.id }, "file-259")).toEqual(
      new Uint8Array([0, 255, 259 % 251]),
    )
    expect(await Environment.uses(environment.id)).toEqual([])
  })
}, 20_000)
