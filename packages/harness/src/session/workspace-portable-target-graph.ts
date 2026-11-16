import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Database } from "bun:sqlite"
import { Global } from "../global"
import { RuntimeContext } from "../lifecycle/context"
import { Storage } from "../storage/storage"
import { initializeSqliteEngine } from "../storage/sqlite-engine"
import type { BlobStore } from "../storage/blobs"
import { WorkspacePortableTree } from "../workspace/portable-tree"
import { WorkspaceTransfer } from "./workspace-transfer"
import { WorkspacePortableSchema as Schema } from "./workspace-portable-schema"
import { SessionTransferOwners as Owners } from "./transfer-owners"
import { SessionTransferStaging as Staging } from "./transfer-staging"
import { SessionTransferStream as Stream } from "./transfer-stream"
import { Session } from "."
import { SessionTransferEpochs as Epochs } from "./transfer-epochs"

export namespace WorkspacePortableTargetGraph {
  export interface Graph {
    rows(): AsyncIterable<Schema.Row>
    workspaces(): AsyncIterable<Schema.Captured>
    references(sessionID: string): AsyncIterable<Schema.Reference>
    memberIDs(): AsyncIterable<string>
    store(workspace: Schema.Captured): BlobStore
    verify(workspace: Schema.Captured): Promise<void>
  }
  function fail(message: string): never {
    throw new Owners.Rejected({ message })
  }
  export async function withGraph<T>(
    input: {
      handoffID: string
      rootSessionID: string
      scopeID: string
      signal: AbortSignal
    },
    body: (graph: Graph) => Promise<T>,
  ): Promise<T> {
    const closing = new AbortController()
    input = Object.freeze({
      handoffID: Epochs.Binding.shape.handoffID.parse(input.handoffID),
      rootSessionID: Epochs.Binding.shape.sessionID.parse(input.rootSessionID),
      scopeID: Epochs.Binding.shape.scopeID.parse(input.scopeID),
      signal: AbortSignal.any([input.signal, closing.signal]),
    })
    const runtime = RuntimeContext.current()
    const handle = Storage.current()
    const store = handle.store
    const artifactDirectory = handle.artifactDirectory
    const objects = handle.artifactObjects
    const blobs = objects?.blobs
    const writerID = objects?.writerID
    const now = objects?.now
    const root = runtime.host.root
    const home = runtime.host.home
    let active = true
    const pending = new Set<Promise<unknown>>()
    function guard() {
      if (!active) fail("Portable Workspace graph callback has ended")
      input.signal.throwIfAborted()
      const current = Storage.current()
      if (
        RuntimeContext.current() !== runtime ||
        current.store !== store ||
        current.artifactDirectory !== artifactDirectory ||
        current.artifactObjects !== objects ||
        objects?.blobs !== blobs ||
        objects?.writerID !== writerID ||
        objects?.now !== now ||
        runtime.host.root !== root ||
        runtime.host.home !== home
      )
        fail("Portable Workspace graph belongs to another storage owner")
    }
    guard()
    const cache = Global.Path.cache
    await initializeSqliteEngine()
    guard()
    await fs.mkdir(cache, { recursive: true })
    guard()
    const directory = await fs.mkdtemp(path.join(cache, "workspace-target-graph-"))
    let db: Database | undefined
    try {
      db = new Database(path.join(directory, "inventory.sqlite"))
      const database = db
      db.exec(
        "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048; CREATE TABLE rows(position TEXT PRIMARY KEY,value TEXT NOT NULL,kind TEXT NOT NULL,workspaceID TEXT,sessionID TEXT); CREATE INDEX rows_owner ON rows(kind,sessionID,position); CREATE TABLE members(id TEXT PRIMARY KEY,metadata TEXT NOT NULL,workspaceID TEXT); CREATE INDEX members_workspace ON members(workspaceID,id); CREATE TABLE visited(workspaceID TEXT,hash TEXT,PRIMARY KEY(workspaceID,hash))",
      )
      using insert = db.prepare("INSERT OR IGNORE INTO rows VALUES(?,?,?,?,?)")
      using previous = db.prepare<{ value: string }, [string]>("SELECT value FROM rows WHERE position=?")
      using visit = db.prepare("INSERT OR IGNORE INTO visited VALUES(?,?)")
      using addMember = db.prepare("INSERT INTO members VALUES(?,?,?)")
      for await (const selected of Staging.members(input)) {
        input.signal.throwIfAborted()
        const context = await Staging.context({
          ...input,
          session: selected.session,
          mapping: {},
          ownerID: "session-workspaces",
        })
        if (!context.staged.relatedRecords || !context.staged.artifact)
          fail("Portable Workspace target requires staged Core and artifact readers")
        const member = Schema.Member.parse((await context.staged.record(Schema.memberKey(context.session)))?.value)
        if (
          member.sessionID !== context.session.id ||
          member.scopeID !== input.scopeID ||
          member.current !== (context.session.workspaceID ?? null)
        )
          fail("Portable Workspace member disagrees with canonical Core")
        const known = new Map<string, number>()
        for await (const record of context.staged.relatedRecords!("session-core")) {
          for (const reference of WorkspaceTransfer.recordReferences(record.key, record.value)) {
            if (reference.scopeID !== input.scopeID) fail("Portable Core Workspace belongs to another Scope")
            known.set(reference.id, Math.max(known.get(reference.id) ?? 0, reference.generation ?? 0))
          }
        }
        const references = new Set<string>()
        let current: Schema.Captured | undefined
        for await (const record of context.staged.records()) {
          input.signal.throwIfAborted()
          const row = Schema.parseRecord(context.session, record.key, record.value, member.current ?? undefined)
          if (row.kind === "reference") {
            if (
              !known.has(row.value.id) ||
              references.has(row.value.id) ||
              row.value.current !== (row.value.id === member.current)
            )
              fail("Portable Workspace references disagree with canonical Core")
            if (!row.value.current && (row.value.generation ?? 0) !== known.get(row.value.id))
              fail("Portable historical Workspace generation changed")
            if (row.value.current && (row.value.generation ?? 0) < known.get(row.value.id)!)
              fail("Portable current Workspace generation precedes its history")
            references.add(row.value.id)
          }
          if (row.kind === "workspace") {
            if (row.value.workspaceID !== member.current || current)
              fail("Portable files do not belong to the current Workspace")
            current = row.value
          }
          if (row.kind === "frame") {
            const artifact = await context.staged.artifact!(
              Schema.artifactKey(context.session, row.workspaceID, row.value.hash),
            )
            if (!artifact || artifact.sha256 !== row.value.hash || artifact.bytes !== row.value.bytes)
              fail("Portable Workspace frame does not match its artifact")
          }
          const position = Schema.order(row)
          const value = JSON.stringify(Schema.Row.parse(row))
          const old = previous.get(position)
          if (old && old.value !== value) fail("Shared portable Workspace metadata changed between members")
          insert.run(
            position,
            value,
            row.kind,
            row.kind === "workspace" ? row.value.workspaceID : row.kind === "frame" ? row.workspaceID : null,
            row.kind === "reference" ? row.sessionID : null,
          )
        }
        if (references.size !== known.size) fail("Portable Workspace references omit canonical history")
        if (member.current && !current) fail("Portable current Workspace has no final files")
        if (current) {
          const reference = Schema.Reference.parse(
            (await context.staged.record(Schema.referenceKey(context.session, current.workspaceID)))?.value,
          )
          if (!reference.current || reference.generation !== current.generation)
            fail("Portable current Workspace generation has no file evidence")
        }
        for await (const artifact of context.staged.artifacts()) {
          if (
            !member.current ||
            JSON.stringify(artifact.key) !==
              JSON.stringify(Schema.artifactKey(context.session, member.current, artifact.sha256))
          )
            fail("Portable Workspace contains an undeclared artifact")
          const metadata = await context.staged.record(
            Schema.frameKey(context.session, member.current, artifact.sha256),
          )
          const frame = Schema.Frame.parse(metadata?.value)
          if (frame.hash !== artifact.sha256 || frame.bytes !== artifact.bytes)
            fail("Portable Workspace artifact has no exact frame metadata")
        }
        addMember.run(context.session.id, JSON.stringify(context.session), member.current)
      }
      function store(workspace: Schema.Captured): BlobStore {
        guard()
        workspace = Schema.Captured.parse(workspace)
        let context: Promise<Owners.TargetContext> | undefined
        function reader() {
          guard()
          if (!context)
            context = (async () => {
              using selected = database.prepare<{ metadata: string }, [string]>(
                "SELECT metadata FROM members WHERE workspaceID=? ORDER BY id LIMIT 1",
              )
              const row = selected.get(workspace.workspaceID)
              if (!row) fail("Portable Workspace has no original staged reader")
              const session = Session.PersistedInfo.parse(JSON.parse(row.metadata))
              const value = await Staging.context({ ...input, session, mapping: {}, ownerID: "session-workspaces" })
              guard()
              return value
            })()
          return context
        }
        return {
          async put() {
            fail("A target cannot append source Workspace objects")
          },
          get(hash, maximum) {
            guard()
            const reading = (async () => {
              const context = await reader()
              guard()
              const frame = Schema.Frame.parse(
                (await context.staged.record(Schema.frameKey(context.session, workspace.workspaceID, hash)))?.value,
              )
              if (frame.hash !== hash || frame.bytes > maximum) fail("Portable Workspace frame exceeds its read bound")
              const artifact = await context.staged.artifact!(
                Schema.artifactKey(context.session, workspace.workspaceID, hash),
              )
              guard()
              if (!artifact || artifact.bytes !== frame.bytes || artifact.sha256 !== hash)
                fail("Portable Workspace frame has no verified artifact")
              const bytes = new Uint8Array(frame.bytes)
              let offset = 0
              for await (const chunk of artifact.read()) {
                guard()
                if (chunk.byteLength > bytes.byteLength - offset)
                  fail("Portable Workspace frame exceeds its declared bytes")
                bytes.set(chunk, offset)
                offset += chunk.byteLength
              }
              if (offset !== bytes.byteLength || createHash("sha256").update(bytes).digest("hex") !== hash)
                fail("Portable Workspace frame checksum changed")
              guard()
              visit.run(workspace.workspaceID, hash)
              return bytes
            })()
            pending.add(reading)
            void reading.finally(() => pending.delete(reading)).catch(() => {})
            return reading
          },
        }
      }
      const graph: Graph = {
        async *memberIDs() {
          guard()
          using rows = database.prepare<{ id: string }, [string]>(
            "SELECT id FROM members WHERE id>? ORDER BY id LIMIT 128",
          )
          let after = ""
          for (;;) {
            guard()
            const page = rows.all(after)
            if (!page.length) return
            for (const row of page) {
              guard()
              yield row.id
            }
            after = page.at(-1)!.id
          }
        },
        rows() {
          return selectedRows()
        },
        async *workspaces() {
          for await (const value of selectedRows("workspace")) {
            if (value.kind !== "workspace") fail("Portable Workspace inventory has another kind")
            yield value.value
          }
        },
        async *references(sessionID) {
          for await (const value of selectedRows("reference", sessionID)) {
            if (value.kind === "reference" && value.sessionID === sessionID) yield value.value
          }
        },
        store,
        async verify(workspace) {
          await using reader = await Stream.open({
            root: workspace.files.tree,
            store: store(workspace),
            directory,
            signal: input.signal,
          })
          for await (const entry of reader.entries()) {
            const metadata = WorkspacePortableTree.Metadata.parse(entry.metadata)
            WorkspacePortableTree.path(entry.id, metadata)
            if (entry.kind !== (metadata.kind === "file" ? "file" : "record"))
              fail("Portable file entry has another native kind")
            for await (const bytes of entry.content)
              if (metadata.kind !== "file" && bytes.byteLength) fail("Portable metadata entry contains file bytes")
          }
          if (!reader.verified()) fail("Portable Workspace graph is incomplete")
          using unseen = database.prepare<{ count: number }, [string]>(
            "SELECT COUNT(*) AS count FROM rows r LEFT JOIN visited v ON r.workspaceID=v.workspaceID AND json_extract(r.value,'$.value.hash')=v.hash WHERE r.kind='frame' AND r.workspaceID=? AND v.hash IS NULL",
          )
          if (unseen.get(workspace.workspaceID)?.count) fail("Portable Workspace contains unreachable frame metadata")
        },
      }
      async function* selectedRows(kind: string | null = null, sessionID: string | null = null) {
        guard()
        using rows = database.prepare<
          { position: string; value: string },
          [string, string | null, string | null, string | null, string | null]
        >(
          "SELECT position,value FROM rows WHERE position>? AND (? IS NULL OR kind=?) AND (? IS NULL OR sessionID=?) ORDER BY position COLLATE BINARY LIMIT 128",
        )
        let after = ""
        for (;;) {
          guard()
          const page = rows.all(after, kind, kind, sessionID, sessionID)
          if (!page.length) return
          for (const row of page) {
            guard()
            yield Schema.Row.parse(JSON.parse(row.value))
          }
          after = page.at(-1)!.position
        }
      }
      return await body(graph)
    } finally {
      active = false
      closing.abort(new Error("Portable Workspace graph callback ended"))
      await Promise.allSettled([...pending])
      db?.close(true)
      await fs.rm(directory, { recursive: true, force: true })
    }
  }
}
