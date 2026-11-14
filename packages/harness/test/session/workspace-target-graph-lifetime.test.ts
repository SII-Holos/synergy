import { expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import { testRuntime } from "../support/runtime"
import { Session } from "../../src/session"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import type { BlobStore } from "../../src/storage/blobs"
import { WorkspaceCatalog } from "../../src/workspace/catalog"
import { SessionTransferCore as Core } from "../../src/session/transfer-core"
import { SessionTransferSource as Source } from "../../src/session/transfer-source"
import { SessionTransferOwners as Owners } from "../../src/session/transfer-owners"
import { SessionTransferStaging as Staging } from "../../src/session/transfer-staging"
import { SessionTransferStream as Stream } from "../../src/session/transfer-stream"
import { WorkspacePortableSchema as Schema } from "../../src/session/workspace-portable-schema"
import { WorkspacePortableTargetGraph as Graph } from "../../src/session/workspace-portable-target-graph"

function objects() {
  const frames = new Map<string, Uint8Array>()
  const store: BlobStore = {
    async put(hash, bytes) {
      frames.set(hash, bytes.slice())
    },
    async get(hash, maximum) {
      const bytes = frames.get(hash)
      if (!bytes || bytes.byteLength > maximum) throw new Error("Missing bounded fixture frame")
      return bytes.slice()
    },
  }
  return { frames, store }
}

test("a retained portable Workspace graph reader rejects after its callback before any staged I/O", async () => {
  const payload = new Uint8Array([0, 255, 37, 128, 10])
  const payloadHash = createHash("sha256").update(payload).digest("hex")
  const inner = objects()
  const tree = await Stream.write({
    store: inner.store,
    owners: { "workspace-files": 1 },
    entries: (async function* () {
      yield {
        id: "private.bin",
        kind: "file",
        metadata: { version: 1, kind: "file", mode: 0o600 },
        content: (async function* () {
          yield payload
        })(),
      }
    })(),
  })
  const register = () => {
    Core.register()
    Owners.register("session-workspaces", {
      version: 1,
      reads: [1],
      stagedDependencies: ["session-core"],
      publicationBefore: ["session-core"],
      applies: () => true,
      async inspect() {
        return { requirements: [], children: (async function* () {})() }
      },
      async freeze() {},
      async *export(context) {
        const workspaceID = context.session.workspaceID
        if (!workspaceID) throw new Error("Fixture requires its actual canonical Workspace")
        const rows: Schema.Row[] = [
          {
            kind: "member",
            value: {
              version: 1,
              sessionID: context.session.id,
              scopeID: context.session.scope.id,
              current: workspaceID,
            },
          },
          {
            kind: "reference",
            sessionID: context.session.id,
            value: { version: 1, id: workspaceID, scopeID: context.session.scope.id, current: true, generation: 1 },
          },
          {
            kind: "workspace",
            value: {
              version: 1,
              workspaceID,
              scopeID: context.session.scope.id,
              generation: 1,
              files: { version: 1, mode: 0o700, tree },
            },
          },
          ...[...inner.frames].map(([hash, bytes]): Schema.Row => ({
            kind: "frame",
            workspaceID,
            scopeID: context.session.scope.id,
            value: { version: 1, hash, bytes: bytes.byteLength },
          })),
        ]
        for (const row of rows) {
          const key = Schema.key(context.session, row)
          yield {
            id: JSON.stringify(key),
            kind: "record",
            metadata: { key },
            content: (async function* () {
              yield Buffer.from(JSON.stringify(row.value))
            })(),
          }
        }
        for (const [hash, bytes] of inner.frames) {
          const key = Schema.artifactKey(context.session, workspaceID, hash)
          yield {
            id: JSON.stringify(key),
            kind: "artifact",
            metadata: { key },
            content: (async function* () {
              yield bytes
            })(),
          }
        }
      },
      async validate() {},
      async publish() {},
    })
  }
  const outer = objects()
  const signal = new AbortController().signal
  await using source = await testRuntime({ register })
  const captured = await source.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const workspace = await WorkspaceCatalog.create({ scopeID: "home", backend: { provider: "fixture", spec: {} } })
        const session = await Session.create({ workspaceID: workspace.id, environmentID: null })
        const binding = {
          sessionID: session.id,
          scopeID: session.scope.id,
          handoffID: "graph-reader-callback-lifetime",
          sourceID: "source",
          targetID: "target",
          fromEpoch: 1,
          toEpoch: 2,
        }
        const prepared = await Source.prepare({ binding, store: outer.store, signal, async verify() {} })
        return { binding, prepared }
      },
    }),
  )
  await using target = await testRuntime({ register })
  await target.run(async () => {
    await Staging.receive({
      handoffID: captured.binding.handoffID,
      root: captured.prepared.root,
      store: outer.store,
      signal,
    })
    let metadataReads = 0
    let artifactStreams = 0
    const readMany = Storage.readMany
    const readBinaryStream = Storage.readBinaryStream
    const metadata = spyOn(Storage, "readMany").mockImplementation(<T>(keys: string[][]) => {
      if (keys.some((key) => key[0] === "session_transfer_staging")) metadataReads++
      return readMany<T>(keys)
    })
    const artifacts = spyOn(Storage, "readBinaryStream").mockImplementation((key, options) => {
      if (key[0] === "session_transfer_staging") artifactStreams++
      return readBinaryStream(key, options)
    })
    try {
      const retained = await Graph.withGraph(
        { handoffID: captured.binding.handoffID, rootSessionID: captured.binding.sessionID, scopeID: "home", signal },
        async (graph) => {
          let workspace: Schema.Captured | undefined
          for await (const value of graph.workspaces()) workspace = value
          if (!workspace) throw new Error("Missing actual staged Workspace")
          await graph.verify(workspace)
          const reader = graph.store(workspace)
          const before = { metadataReads, artifactStreams }
          expect(await reader.get(payloadHash, payload.byteLength)).toEqual(payload)
          expect(metadataReads).toBeGreaterThan(before.metadataReads)
          expect(artifactStreams).toBeGreaterThan(before.artifactStreams)
          return reader
        },
      )
      const closed = { metadataReads, artifactStreams }
      await expect(Promise.resolve().then(() => retained.get(payloadHash, payload.byteLength))).rejects.toThrow()
      expect({ metadataReads, artifactStreams }).toEqual(closed)
    } finally {
      artifacts.mockRestore()
      metadata.mockRestore()
    }
  })
})
