import { expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionHistory } from "../../src/session/history"
import { MessageV2 } from "../../src/session/message-v2"
import { SnapshotRanges } from "../../src/session/snapshot-ranges"
import { Storage } from "../../src/storage/storage"
import { WorkspaceCatalog } from "../../src/workspace/catalog"
import { WorkspaceBlobs, WorkspaceContent, type BlobStore } from "../../src/workspace/content"
import { WorkspaceEvidence } from "../../src/workspace/evidence"
import { WorkspaceOperations } from "../../src/workspace/operations"
import { WorkspaceTree } from "../../src/workspace/tree"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"
import { storageTestBackends } from "../support/storage-backends"

for (const backend of storageTestBackends())
  test(`${backend}: oversized operation snapshots omit history while preserving durable workspace bytes`, async () => {
    const blobs: BlobStore = {
      put: (hash, bytes) => Storage.writeBinary(["evidence_fixture", hash], bytes),
      get: (hash) => Storage.readBinary(["evidence_fixture", hash]),
    }
    await using runtime = await testRuntime({
      postgres: backend === "postgres" ? process.env.SYNERGY_TEST_POSTGRES_URL : undefined,
      register: () => WorkspaceBlobs.register("evidence-fixture", blobs),
    })
    await runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        async fn() {
          const session = await Session.create()
          const message = await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "user",
            isRoot: true,
            time: { created: Date.now() },
            agent: "test",
            model: { providerID: "test", modelID: "test" },
          })
          const info = await WorkspaceCatalog.create({
            scopeID: ScopeContext.current.scope.id,
            backend: { provider: "objects", spec: { blobStore: "evidence-fixture" } },
          })
          const selection = { workspaceID: info.id, scopeID: info.scopeID }
          const small = new TextEncoder().encode("small baseline\n")
          const large = new Uint8Array(2 * 1024 * 1024 + 1).fill(65)
          const write = (id: string, file: string, data: Uint8Array, previous: Uint8Array | null) =>
            WorkspaceEvidence.provide(
              { scopeID: info.scopeID, sessionID: session.id, messageID: message.id, toolCallID: id },
              () =>
                WorkspaceOperations.write({
                  ...selection,
                  id,
                  path: file,
                  data,
                  expectedVersion: previous ? `sha256:${WorkspaceTree.hash(previous)}` : null,
                }),
            )
          await write("small", "result.txt", small, null)
          await write("grow", "result.txt", large, small)
          expect((await WorkspaceOperations.get("grow", info.scopeID)).state).toBe("completed")
          expect(await WorkspaceContent.read(selection, "result.txt")).toEqual(large)
          await write("next", "other.txt", small, null)
          const parts = (await MessageV2.get({ sessionID: session.id, messageID: message.id })).parts.filter(
            (part): part is MessageV2.PatchPart => part.type === "patch",
          )
          const grow = parts.find((part) => part.operation?.toolCallID === "grow")!
          const next = parts.find((part) => part.operation?.toolCallID === "next")!
          const omission = { file: "result.txt", reason: "size_limit" as const }
          expect(grow.files).toEqual([])
          expect(grow.operation).toMatchObject({ status: "complete", baselineOmissions: [], omissions: [omission] })
          expect(next.files).toEqual(["other.txt"])
          expect(next.operation).toMatchObject({
            status: "complete",
            baselineOmissions: [omission],
            omissions: [omission],
          })
          const ranges = SnapshotRanges.fromMessages([{ info: message, parts }])
          expect(ranges.find((range) => range.operationID === grow.id)?.omissions).toEqual([omission])
          await expect(
            SessionHistory.fileDiff({
              sessionID: session.id,
              workspaceID: info.id,
              generation: info.binding.generation,
              file: "result.txt",
            }),
          ).rejects.toThrow("not fully captured")
          await expect(
            SessionHistory.previewFiles({
              sessionID: session.id,
              partID: grow.id,
              files: ["result.txt"],
            }),
          ).rejects.toThrow("No complete snapshot pair")
          await expect(
            SessionHistory.previewFiles({
              sessionID: session.id,
              files: ["result.txt"],
            }),
          ).rejects.toThrow("No complete snapshot pair")
          expect(await WorkspaceContent.read(selection, "result.txt")).toEqual(large)
          await write("shrink", "result.txt", small, large)
          const shrink = (await MessageV2.get({ sessionID: session.id, messageID: message.id })).parts.find(
            (part): part is MessageV2.PatchPart => part.type === "patch" && part.operation?.toolCallID === "shrink",
          )!
          expect(shrink.files).toEqual([])
          expect(shrink.operation).toMatchObject({ status: "complete", baselineOmissions: [omission], omissions: [] })
        },
      })
    })
  })
