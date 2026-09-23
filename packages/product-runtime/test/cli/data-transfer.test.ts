import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { DataTransfer } from "../../src/cli/data/transfer"
import { StorageBootstrap } from "@ericsanchezok/synergy-harness/storage/bootstrap"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { SnapshotArchive } from "@ericsanchezok/synergy-harness/session/snapshot-archive"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { AgendaStore } from "@ericsanchezok/synergy-workflows/agenda/store"
import { createLocalHost } from "@ericsanchezok/synergy-runtime-local/host"
const runtime = await testRuntime()

test("Home imports normalize historical directory selections without local adoption", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir(),
      working = await tmpdir()
    const scope = await tmp.scope()
    const sourceRoot = path.join(tmp.path, "source")
    const targetRoot = path.join(tmp.path, "target")
    const prepared = await StorageBootstrap.prepare({ root: sourceRoot })
    let sessionID!: string
    let agendaID!: string
    try {
      await Storage.provide({ store: prepared.store, artifactDirectory: path.join(sourceRoot, "data") }, () =>
        ScopeContext.provide({
          scope,
          async fn() {
            await Storage.write(["projects", scope.id], scope)
            const session = await Session.create({})
            sessionID = session.id
            const key = ["sessions", scope.id, session.id, "info"]
            await Storage.update<Record<string, unknown>>(key, (record) => {
              delete record.workspaceID
              record.workspace = { type: "directory", path: working.path, scopeID: scope.id, futureField: "retained" }
            })
            const item = await AgendaStore.create({ createdBy: "user", title: "Historical default", prompt: "test" })
            agendaID = item.id
            await Storage.update<{ origin: { workspaceID?: string | null } }>(
              ["agenda", "items", scope.id, item.id],
              (record) => {
                delete record.origin.workspaceID
              },
            )
          },
        }),
      )
      await prepared.activate()
    } finally {
      await prepared.store.close()
    }
    const fresh = await StorageBootstrap.prepare({ root: targetRoot })
    await fresh.activate()
    await fresh.store.close()
    await using locks = await SnapshotArchive.lockHomes([sourceRoot, targetRoot])
    await DataTransfer.merge(sourceRoot, targetRoot)
    const target = (await StorageBootstrap.inspect(targetRoot))!
    try {
      const session = await target.store.read<{ workspaceID: string; workspace?: unknown }>([
        "sessions",
        scope.id,
        sessionID,
        "info",
      ])
      expect(session.workspace).toBeUndefined()
      expect(session.workspaceID.startsWith("wsp_")).toBe(true)
      const imported = await target.store.read<WorkspaceCatalog.Info>(["workspace", session.workspaceID])
      expect(imported.binding).toMatchObject({ state: "unbound", path: working.path })
      expect(imported.metadata.futureField).toBe("retained")
      const agenda = await target.store.read<{ origin: { workspaceID: string } }>([
        "agenda",
        "items",
        scope.id,
        agendaID,
      ])
      expect(
        (await target.store.read<WorkspaceCatalog.Info>(["workspace", agenda.origin.workspaceID])).binding,
      ).toMatchObject({ state: "unbound", path: scope.local!.directory })
    } finally {
      await target.store.close()
    }
  }))

test.each([
  { collision: false, metadata: true },
  { collision: true, metadata: true },
  { collision: true, metadata: false },
])(
  "untrusted Home merge detaches Workspace authority and remaps history (%j)",
  ({ collision, metadata }) =>
    runtime.run(async () => {
      await using tmp = await tmpdir(),
        working = await tmpdir(),
        existing = await tmpdir()
      const scope = await tmp.scope()
      const sourceRoot = path.join(tmp.path, "source")
      const targetRoot = path.join(tmp.path, "target")
      const targetHost = createLocalHost({ root: targetRoot })
      const source = await StorageBootstrap.prepare({ root: sourceRoot })
      const sessionID = Identifier.descending("session")
      const targetSessionID = Identifier.descending("session")
      const messageID = Identifier.descending("message")
      const partID = Identifier.ascending("part")
      const sessionKey = ["sessions", scope.id, sessionID]
      const patchKey = [...sessionKey, "messages", messageID, "parts", partID]
      let workspace!: WorkspaceCatalog.Info
      let agendaID!: string
      try {
        await Storage.provide({ store: source.store, artifactDirectory: path.join(sourceRoot, "data") }, () =>
          ScopeContext.provide({
            scope,
            workspace: null,
            async fn() {
              await Storage.write(["projects", scope.id], scope)
              workspace = await WorkspaceCatalog.register({
                scopeID: scope.id,
                type: "directory",
                hostID: await targetHost.workspaceLocation!.hostID(),
                ...(await targetHost.workspaceLocation!.identify(working.path)),
              })
              await Session.create({ id: sessionID, workspaceID: workspace.id })
              const provenance = { id: workspace.id, generation: 1, root: workspace.binding.path! }
              const diff = { file: "file.txt", workspace: provenance, additions: 1, deletions: 0 }
              await Session.updateMessage({
                id: messageID,
                sessionID,
                role: "user",
                time: { created: Date.now() },
                agent: "synergy",
                model: { providerID: "test", modelID: "test" },
                summary: { diffs: [diff] },
              })
              await Storage.write(patchKey, {
                type: "patch",
                id: partID,
                sessionID,
                messageID,
                hash: "",
                files: ["file.txt"],
                workspace: provenance,
                operation: { status: "incomplete" },
              })
              await Storage.write([...sessionKey, "summary"], [diff])
              await Storage.write([...sessionKey, "summary_cursor"], {
                version: 3,
                ranges: [{ workspace: provenance, files: ["file.txt"], incomplete: true }],
              })
              await Storage.write([...sessionKey, "future-owner"], { workspaceID: workspace.id, untouched: true })
              const item = await AgendaStore.create({
                createdBy: "user",
                title: "Imported schedule",
                prompt: "test",
                sessionID,
              })
              agendaID = item.id
              if (!metadata) await Storage.remove(["workspace", workspace.id])
            },
          }),
        )
        await source.activate()
      } finally {
        await source.store.close()
      }
      const target = await StorageBootstrap.prepare({ root: targetRoot })
      try {
        if (collision) {
          await Storage.provide({ store: target.store, artifactDirectory: path.join(targetRoot, "data") }, () =>
            ScopeContext.provide({
              scope,
              workspace: null,
              async fn() {
                await Storage.write(["projects", scope.id], scope)
                await Storage.write(["workspace", workspace.id], {
                  ...workspace,
                  binding: { ...workspace.binding, ...(await targetHost.workspaceLocation!.identify(existing.path)) },
                })
                await Storage.write(["workspace_scope", scope.id, workspace.id], workspace.id)
                await Session.create({ id: targetSessionID, workspaceID: workspace.id })
              },
            }),
          )
        }
        await target.activate()
      } finally {
        await target.store.close()
      }
      await using locks = await SnapshotArchive.lockHomes([sourceRoot, targetRoot])
      await DataTransfer.merge(sourceRoot, targetRoot)
      const merged = (await StorageBootstrap.inspect(targetRoot))!
      let catalogIDs: string[] = []
      try {
        const session = await merged.store.read<{ workspaceID: string }>([...sessionKey, "info"])
        const imported = await merged.store.read<WorkspaceCatalog.Info>(["workspace", session.workspaceID])
        expect(imported.binding.state).toBe("unbound")
        expect(imported.sharedWritableWorkspaceIDs).toEqual([])
        expect(imported.binding.path).toBe(metadata ? workspace.binding.path : null)
        if (collision) {
          expect(session.workspaceID).not.toBe(workspace.id)
          expect((await merged.store.read<WorkspaceCatalog.Info>(["workspace", workspace.id])).binding.path).toBe(
            await fs.realpath(existing.path),
          )
          expect(
            (await merged.store.read<{ workspaceID: string }>(["sessions", scope.id, targetSessionID, "info"]))
              .workspaceID,
          ).toBe(workspace.id)
        }
        expect(
          (await merged.store.read<{ workspace: { id: string; generation: number; root: string } }>(patchKey))
            .workspace,
        ).toEqual({ id: imported.id, generation: 1, root: workspace.binding.path! })
        expect(
          (await merged.store.read<Array<{ workspace: { id: string } }>>([...sessionKey, "summary"]))[0]!.workspace.id,
        ).toBe(imported.id)
        expect(
          (
            await merged.store.read<{ summary: { diffs: Array<{ workspace: { id: string } }> } }>([
              ...sessionKey,
              "messages",
              messageID,
              "info",
            ])
          ).summary.diffs[0]!.workspace.id,
        ).toBe(imported.id)
        expect(
          (await merged.store.read<{ ranges: Array<{ workspace: { id: string } }> }>([...sessionKey, "summary_cursor"]))
            .ranges[0]!.workspace.id,
        ).toBe(imported.id)
        expect(
          (await merged.store.read<{ origin: { workspaceID: string } }>(["agenda", "items", scope.id, agendaID])).origin
            .workspaceID,
        ).toBe(imported.id)
        expect(
          await merged.store.read<{ workspaceID: string; untouched: boolean }>([...sessionKey, "future-owner"]),
        ).toEqual({ workspaceID: workspace.id, untouched: true })
        expect((await merged.store.verify()).issues).toEqual([])
        catalogIDs = await merged.store.scan(["workspace"])
      } finally {
        await merged.store.close()
      }
      await DataTransfer.merge(sourceRoot, targetRoot)
      const repeated = (await StorageBootstrap.inspect(targetRoot))!
      try {
        expect(await repeated.store.scan(["workspace"])).toEqual(catalogIDs)
      } finally {
        await repeated.store.close()
      }
    }),
  20000,
)

test("merge keeps the target session aggregate and retains skipped source evidence", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const id = Identifier.descending("session")
    const addedID = Identifier.descending("session")
    const sourceRoot = path.join(tmp.path, "source")
    const targetRoot = path.join(tmp.path, "target")
    for (const [root, title] of [
      [sourceRoot, "source"],
      [targetRoot, "target"],
    ]) {
      const prepared = await StorageBootstrap.prepare({ root })
      try {
        await Storage.provide({ store: prepared.store, artifactDirectory: path.join(root, "data") }, () =>
          ScopeContext.provide({
            scope,
            fn: async () => {
              await Storage.write(["projects", scope.id], scope)
              await Session.create({ id, title })
              await Storage.writeBinary(["sessions", scope.id, id, "rollout", "blobs", "packed"], Buffer.from(title))
              await Storage.write(["sessions", scope.id, id, "owner-extension"], { title })
              if (root === sourceRoot) {
                await Session.create({ id: addedID, title: "new session" })
                await Storage.writeBinary(
                  ["sessions", scope.id, addedID, "rollout", "blobs", "new-content"],
                  Buffer.from("new evidence"),
                )
                await Storage.write(["sessions", scope.id, id, "source-only"], { preserve: true })
                await Bun.write(path.join(root, "data", "sessions", scope.id, id, "private.bin"), "source evidence")
              }
            },
          }),
        )
        await prepared.activate()
      } finally {
        await prepared.store.close()
      }
    }
    await using locks = await SnapshotArchive.lockHomes([sourceRoot, targetRoot])
    const result = await DataTransfer.merge(sourceRoot, targetRoot)
    expect(result.skippedSessions).toBe(1)
    const target = await StorageBootstrap.inspect(targetRoot)
    if (!target) throw new Error("missing target")
    try {
      expect(await target.store.read<{ title: string }>(["sessions", scope.id, id, "owner-extension"])).toEqual({
        title: "target",
      })
      expect((await target.store.readMany([["sessions", scope.id, id, "source-only"]]))[0]).toBeUndefined()
      expect(await Bun.file(path.join(targetRoot, "data", "sessions", scope.id, id, "private.bin")).exists()).toBe(
        false,
      )
      expect(await target.store.read(["session_index", addedID])).toMatchObject({ scopeID: scope.id })
      await Storage.provide(target, async () => {
        expect(
          Buffer.from(await Storage.readBinary(["sessions", scope.id, id, "rollout", "blobs", "packed"])).toString(),
        ).toBe("target")
        expect(
          Buffer.from(
            await Storage.readBinary(["sessions", scope.id, addedID, "rollout", "blobs", "new-content"]),
          ).toString(),
        ).toBe("new evidence")
      })
      const [transfer] = await target.store.query<{ backup: string }>({ kind: "storage_transfer" })
      expect(
        await Bun.file(
          path.join(targetRoot, transfer.value.backup, "data", "sessions", scope.id, id, "private.bin"),
        ).text(),
      ).toBe("source evidence")
      expect((await target.store.verify()).issues).toEqual([])
    } finally {
      await target.store.close()
    }
  }))

test("merge refuses authority records from another home; trusted relocation keeps them", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const sourceRoot = path.join(tmp.path, "source")
    const targetRoot = path.join(tmp.path, "target")
    const trustedRoot = path.join(tmp.path, "trusted")
    const source = await StorageBootstrap.prepare({ root: sourceRoot })
    try {
      await source.store.write(["plugin-approvals", "records", "plugin-x"], { grant: "broad" })
      await source.store.write(["notes", "scope", "note"], { text: "payload" })
      await source.store.write(["compat_catalog", "scope", "0000000000000001", "session"], { status: "pending" })
      await source.activate()
    } finally {
      await source.store.close()
    }
    for (const root of [targetRoot, trustedRoot]) {
      const prepared = await StorageBootstrap.prepare({ root })
      try {
        await prepared.activate()
      } finally {
        await prepared.store.close()
      }
    }
    await using locks = await SnapshotArchive.lockHomes([sourceRoot, targetRoot, trustedRoot])
    await DataTransfer.merge(sourceRoot, targetRoot)
    const target = await StorageBootstrap.inspect(targetRoot)
    if (!target) throw new Error("missing target")
    try {
      expect((await target.store.readMany([["plugin-approvals", "records", "plugin-x"]]))[0]).toBeUndefined()
      expect(await target.store.read<{ text: string }>(["notes", "scope", "note"])).toEqual({ text: "payload" })
      expect(await target.store.list(["compat_catalog"])).toEqual([])
    } finally {
      await target.store.close()
    }
    await DataTransfer.merge(sourceRoot, trustedRoot, { trusted: true })
    const trusted = await StorageBootstrap.inspect(trustedRoot)
    if (!trusted) throw new Error("missing trusted target")
    try {
      expect(await trusted.store.read<{ grant: string }>(["plugin-approvals", "records", "plugin-x"])).toEqual({
        grant: "broad",
      })
      expect(await trusted.store.list(["compat_catalog"])).toEqual([])
    } finally {
      await trusted.store.close()
    }
  }))

test("portable pack restores authority without copying the source database identity", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const sourceRoot = path.join(tmp.path, "source")
    const restoredRoot = path.join(tmp.path, "restored")
    const source = await StorageBootstrap.prepare({ root: sourceRoot })
    await source.store.write(["future-owner", "record"], { nested: { unknown: 42 } })
    await source.activate()
    await source.store.close()
    await DataTransfer.pack(sourceRoot, path.join(restoredRoot, "data"))
    expect(await Bun.file(path.join(restoredRoot, "data", "storage", "manifest.json")).exists()).toBe(false)
    const restored = await StorageBootstrap.prepare({ root: restoredRoot })
    try {
      expect(await restored.store.read<{ nested: { unknown: number } }>(["future-owner", "record"])).toEqual({
        nested: { unknown: 42 },
      })
      expect(restored.manifest.storeID).not.toBe(source.manifest.storeID)
      await restored.activate()
      await fs.rm(sourceRoot, { recursive: true })
      expect(await restored.store.read<{ nested: { unknown: number } }>(["future-owner", "record"])).toEqual({
        nested: { unknown: 42 },
      })
    } finally {
      await restored.store.close()
    }
  }))

afterRuntimeTests(() => runtime.close())
