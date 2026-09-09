import { SessionSchemaRegistry } from "../schema-registry"
import { SessionExecutionContributions } from "../execution-contributions"
import { RolloutAttachment } from "./attachment"
import z from "zod"
import { BlobReader, Uint8ArrayReader, ZipReader, ZipWriter, type FileEntry, type Writer } from "@zip.js/zip.js"
import { Identifier } from "../../id/id"
import { ScopeContext } from "../../scope/context"
import { Storage } from "../../storage/storage"
import { Session } from ".."
import { SessionExport } from "../session-export"
import { SessionImport } from "../session-import"
import { SessionHistory } from "../history"
import { RolloutArtifact } from "./artifact"
import { RolloutSnapshot } from "./snapshot"
import { RolloutSchema } from "./schema"
import { RolloutQuery } from "./query"
import { RolloutJournal } from "./journal"
import { SnapshotArchive } from "../snapshot-archive"
import { SnapshotRecords } from "../snapshot-records"
import { SnapshotLifecycle } from "../snapshot-lifecycle"

export namespace RolloutArchive {
  const MAX_ENTRY_BYTES = 64 * 1024 * 1024
  const MAX_TOTAL_BYTES = 16 * 1024 * 1024 * 1024
  const MAX_ENTRIES = 100_000
  const File = z
    .object({
      path: z.string(),
      bytes: z.number().int().nonnegative().max(MAX_ENTRY_BYTES),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict()
  export const Manifest = z
    .object({
      format: z.literal("synergy-rollout"),
      version: z.literal(1),
      exportedAt: z.number(),
      rootSessionID: z.string(),
      runID: z.string().optional(),
      snapshots: z.array(RolloutSnapshot.Info),
      artifacts: z.array(
        z.object({ owner: RolloutSchema.Owner, ref: RolloutArtifact.Ref, files: z.array(z.string()) }).strict(),
      ),
      files: z.array(File),
      fileSnapshots: z
        .array(
          z
            .object({
              sessionID: z.string(),
              roots: z.array(z.string().regex(/^[a-f0-9]{40}$/)).min(1),
              packs: z.array(z.array(z.string()).min(1)).min(1),
            })
            .strict(),
        )
        .default([]),
      integrity: z.object({ complete: z.boolean(), missing: z.array(z.string()) }).strict(),
    })
    .strict()
  export type Manifest = z.infer<typeof Manifest>
  type Input = { sessionID: string; runID?: string }
  function digest(bytes: Uint8Array) {
    return new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  }
  function pathValid(path: string) {
    if (
      !/^[a-zA-Z0-9_.\/-]+$/.test(path) ||
      path.startsWith("/") ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new Error("Invalid rollout ZIP path")
    return path
  }
  function references(value: unknown, result = new Map<string, RolloutArtifact.Ref>()) {
    if (!value || typeof value !== "object") return result
    const ref = RolloutArtifact.Ref.safeParse(value)
    if (ref.success) {
      const previous = result.get(ref.data.id)
      if (!previous || previous.chunks <= ref.data.chunks) result.set(ref.data.id, ref.data)
      return result
    }
    for (const child of Object.values(value)) references(child, result)
    return result
  }

  export async function write(input: Input, target: Writer<unknown> | WritableStream<Uint8Array>) {
    await Session.flushPartWrites()
    const session = await Session.get(input.sessionID)
    const owner = { kind: "session" as const, scopeID: session.scope.id, sessionID: session.id }
    const tree = input.runID ? await RolloutQuery.tree(owner, input.runID) : undefined
    const report = await SessionExport.generate({ sessionID: input.sessionID, mode: "full" })
    if (tree) {
      const included = new Set(
        tree.snapshots.flatMap((snapshot) => (snapshot.owner.kind === "session" ? [snapshot.owner.sessionID] : [])),
      )
      report.sessions = report.sessions.filter((session) => included.has(session.info.id))
    }
    const boundaries =
      tree?.snapshots ??
      (await Promise.all(
        report.sessions.map((session) =>
          RolloutSnapshot.read({ kind: "session", scopeID: session.info.scope.id, sessionID: session.info.id }),
        ),
      ))
    const grouped = Map.groupBy(boundaries, (snapshot) => JSON.stringify(snapshot.owner))
    const snapshots = [...grouped.values()].map((items) => {
      const merged = structuredClone(items[0])
      for (const snapshot of items.slice(1)) {
        merged.revision = Math.max(merged.revision, snapshot.revision)
        merged.gaps = [...new Set([...merged.gaps, ...snapshot.gaps])]
        for (const key of ["runs", "segments", "calls", "attempts", "tools", "processes"] as const)
          Object.assign(merged, {
            [key]: [...new Map([...merged[key], ...snapshot[key]].map((record) => [record.id, record])).values()],
          })
      }
      return RolloutSnapshot.Info.parse(merged)
    })
    const manifest: Manifest = {
      format: "synergy-rollout",
      version: 1,
      exportedAt: Date.now(),
      rootSessionID: input.sessionID,
      runID: input.runID,
      snapshots,
      artifacts: [],
      files: [],
      fileSnapshots: [],
      integrity: { complete: true, missing: [] },
    }
    const zip = new ZipWriter(target, { level: 0, useWebWorkers: false })
    let total = 0
    async function add(path: string, data: Uint8Array) {
      pathValid(path)
      total += data.byteLength
      if (data.byteLength > MAX_ENTRY_BYTES || total > MAX_TOTAL_BYTES || manifest.files.length >= MAX_ENTRIES - 1)
        throw new Error("Rollout ZIP size limit exceeded")
      await zip.add(path, new Uint8ArrayReader(data))
      manifest.files.push({ path, bytes: data.byteLength, sha256: digest(data) })
    }
    async function json(path: string, data: unknown) {
      await add(path, new TextEncoder().encode(JSON.stringify(data)))
    }
    await json("transcript.json", report)
    for (const data of report.sessions)
      for (const message of data.messages)
        for (const part of message.parts) {
          const attachments =
            part.type === "attachment"
              ? [part]
              : part.type === "tool" && part.state.status === "completed"
                ? (part.state.attachments ?? [])
                : []
          for (const attachment of attachments)
            if (
              !attachment.artifact &&
              !attachment.url.startsWith("data:") &&
              attachment.mime !== "application/x-directory"
            )
              manifest.integrity.missing.push(`attachment:${data.info.id}:${attachment.id}:original_not_recorded`)
          if (
            part.type === "tool" &&
            part.state.status === "completed" &&
            !part.state.outputArtifact &&
            (part.state.time.compacted ||
              part.state.metadata.truncated ||
              part.state.metadata.rolloutLegacyOutput === "missing" ||
              part.state.metadata.rolloutImportMissingOutput)
          )
            manifest.integrity.missing.push(`tool:${data.info.id}:${part.id}:original_not_recorded`)
        }
    for (const data of report.sessions) {
      const history = await SessionHistory.readEvents(data.info.id)
      await json(`sessions/${data.info.id}/history.json`, history)
      await json(`sessions/${data.info.id}/workflow.json`, {
        workflow: data.info.workflow,
        ...(await SessionExecutionContributions.archive(data.info)),
      })
      const roots = data.messages.flatMap((message) => message.parts.flatMap(SnapshotRecords.partRoots))
      if (roots.length) {
        const exported = await SnapshotArchive.exportSession(data.info.id, roots, async (packs, retained) => {
          const files: string[][] = []
          for (const [index, file] of packs.entries()) {
            const names: string[] = []
            const handle = Bun.file(file)
            for (let offset = 0; offset < handle.size; offset += RolloutArtifact.CHUNK_BYTES) {
              const name = `file-snapshots/${data.info.id}/${index}/${names.length}.bin`
              await add(
                name,
                new Uint8Array(await handle.slice(offset, offset + RolloutArtifact.CHUNK_BYTES).arrayBuffer()),
              )
              names.push(name)
            }
            files.push(names)
          }
          manifest.fileSnapshots.push({ sessionID: data.info.id, roots: retained, packs: files })
        })
        for (const root of exported.missing) manifest.integrity.missing.push(`file-snapshot:${data.info.id}:${root}`)
      }
    }
    for (let index = 0; index < snapshots.length; index++) {
      const snapshot = snapshots[index]
      const refs = references(snapshot)
      const history = await Storage.read([...RolloutArtifact.root(snapshot.owner), "history"]).catch((error) => {
        if (error instanceof Storage.NotFoundError) return undefined
        throw error
      })
      if (history) await json(`owners/${index}/history.json`, history)
      const imported = await Storage.read([...RolloutArtifact.root(snapshot.owner), "import"]).catch((error) => {
        if (error instanceof Storage.NotFoundError) return undefined
        throw error
      })
      if (imported) {
        references(imported, refs)
        await json(`owners/${index}/import.json`, imported)
      }
      const transcript = report.sessions.find(
        (session) => snapshot.owner.kind === "session" && session.info.id === snapshot.owner.sessionID,
      )
      if (transcript) references(transcript, refs)
      let events: RolloutJournal.Event[] = []
      let page = 0
      const runIDs = new Set(snapshot.runs.map((run) => run.id))
      for await (const event of RolloutJournal.events(snapshot.owner, snapshot.revision)) {
        if (event.kind === "record" && !runIDs.has(event.key[1])) continue
        events.push(event)
        if (events.length < 128) continue
        await json(`owners/${index}/events/${page++}.json`, events)
        events = []
      }
      if (events.length) await json(`owners/${index}/events/${page}.json`, events)
      for (const ref of refs.values()) {
        if (
          ref.mediaType === "application/json" &&
          ref.bytes > 0 &&
          ref.bytes <= MAX_ENTRY_BYTES &&
          ref.status === "complete"
        ) {
          try {
            const chunks: Uint8Array[] = []
            for await (const chunk of RolloutArtifact.read(snapshot.owner, ref)) chunks.push(chunk)
            references(JSON.parse(Buffer.concat(chunks).toString()), refs)
          } catch (error) {
            if (!(error instanceof SyntaxError))
              manifest.integrity.missing.push(`artifact:${index}:${ref.id}:unreadable_json_references`)
          }
        }
        const files: string[] = []
        try {
          let chunkIndex = 0
          for await (const chunk of RolloutArtifact.read(snapshot.owner, ref)) {
            const path = `owners/${index}/artifacts/${ref.id}/${chunkIndex++}.bin`
            await add(path, chunk)
            files.push(path)
          }
          manifest.artifacts.push({ owner: snapshot.owner, ref, files })
          if (ref.status !== "complete") manifest.integrity.complete = false
        } catch (error) {
          manifest.integrity.missing.push(
            `artifact:${index}:${ref.id}:${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      if (!snapshot.runs.length) manifest.integrity.missing.push(`owner:${index}:historical_calls_not_recorded`)
      if (
        snapshot.gaps.length ||
        snapshot.runs.some((run) => run.status === "running" || run.recording !== "complete") ||
        snapshot.processes.some((process) => process.status === "running")
      )
        manifest.integrity.complete = false
    }
    manifest.integrity.complete &&= manifest.integrity.missing.length === 0
    const data = new TextEncoder().encode(JSON.stringify(Manifest.parse(manifest)))
    if (data.byteLength > MAX_ENTRY_BYTES) throw new Error("Rollout ZIP manifest size limit exceeded")
    await zip.add("manifest.json", new Uint8ArrayReader(data))
    await zip.close()
  }

  export function stream(input: Input) {
    let fail: (error: unknown) => void = () => {}
    const stream = new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        fail = (error) => controller.error(error)
      },
    })
    void write(input, stream.writable).catch(fail)
    return stream.readable
  }

  async function open(blob: Blob) {
    if (blob.size > MAX_TOTAL_BYTES) throw new Error("Rollout ZIP size limit exceeded")
    const reader = new ZipReader(new BlobReader(blob), { checkSignature: true, useWebWorkers: false })
    try {
      const entries = new Map<string, FileEntry>()
      let total = 0
      for await (const entry of reader.getEntriesGenerator()) {
        pathValid(entry.filename)
        if (
          entry.directory ||
          entry.encrypted ||
          entry.uncompressedSize > MAX_ENTRY_BYTES ||
          entries.size >= MAX_ENTRIES
        )
          throw new Error("Invalid rollout ZIP entry")
        total += entry.uncompressedSize
        if (total > MAX_TOTAL_BYTES || entries.has(entry.filename))
          throw new Error("Invalid rollout ZIP size or duplicate path")
        entries.set(entry.filename, entry)
      }
      async function bytes(path: string) {
        const entry = entries.get(path)
        if (!entry) throw new Error(`Rollout ZIP integrity: missing ${path}`)
        let size = 0
        const chunks: Uint8Array[] = []
        await entry.getData(
          new WritableStream<Uint8Array>({
            write(chunk) {
              size += chunk.byteLength
              if (size > entry.uncompressedSize || size > MAX_ENTRY_BYTES)
                throw new Error("Rollout ZIP size limit exceeded")
              chunks.push(chunk)
            },
          }),
        )
        if (size !== entry.uncompressedSize) throw new Error("Rollout ZIP integrity: size mismatch")
        return Buffer.concat(chunks, size)
      }
      const manifest = Manifest.parse(JSON.parse((await bytes("manifest.json")).toString()))
      const declared = new Set(["manifest.json"])
      const artifacts = new Map<string, Manifest["artifacts"][number]>()
      const files = new Map(manifest.files.map((file) => [file.path, file]))
      const payloadFiles = new Set<string>()
      for (const file of manifest.files) {
        pathValid(file.path)
        if (declared.has(file.path)) throw new Error("Rollout ZIP integrity: duplicate manifest path")
        declared.add(file.path)
        const data = await bytes(file.path)
        if (data.byteLength !== file.bytes || digest(data) !== file.sha256)
          throw new Error("Rollout ZIP integrity check failed")
      }
      if (declared.size !== entries.size) throw new Error("Rollout ZIP integrity: unlisted files")
      for (const artifact of manifest.artifacts) {
        const key = `${JSON.stringify(artifact.owner)}:${artifact.ref.id}`
        if (artifacts.has(key)) throw new Error("Rollout ZIP integrity: duplicate artifact")
        artifacts.set(key, artifact)
        if (artifact.files.length !== artifact.ref.chunks)
          throw new Error("Rollout ZIP integrity: artifact chunks mismatch")
        const hash = new Bun.CryptoHasher("sha256")
        let size = 0
        for (const path of artifact.files) {
          if (payloadFiles.has(path)) throw new Error("Rollout ZIP integrity: duplicate payload file")
          payloadFiles.add(path)
          if (!declared.has(path) || path === "manifest.json")
            throw new Error("Rollout ZIP integrity: undeclared artifact")
          const data = await bytes(path)
          if (data.byteLength > RolloutArtifact.CHUNK_BYTES)
            throw new Error("Rollout ZIP integrity: oversized artifact chunk")
          hash.update(data)
          size += data.byteLength
        }
        if (
          size !== artifact.ref.bytes ||
          (artifact.ref.status === "complete" && hash.digest("hex") !== artifact.ref.sha256)
        )
          throw new Error("Rollout ZIP integrity: artifact hash mismatch")
      }
      function validateReferences(value: unknown, owner: RolloutSchema.Owner) {
        if (!value || typeof value !== "object") return
        const parsed = RolloutArtifact.Ref.safeParse(value)
        if (!parsed.success) {
          for (const entry of Object.values(value)) validateReferences(entry, owner)
          return
        }
        const ref = parsed.data
        const artifact = artifacts.get(`${JSON.stringify(owner)}:${ref.id}`)
        if (!artifact) {
          if (manifest.integrity.complete) throw new Error("Rollout ZIP integrity: missing referenced artifact")
          return
        }
        const size = artifact.files.slice(0, ref.chunks).reduce((sum, path) => sum + files.get(path)!.bytes, 0)
        if (
          ref.mediaType !== artifact.ref.mediaType ||
          ref.chunks > artifact.ref.chunks ||
          ref.bytes !== size ||
          (ref.status === "complete" && (ref.sha256 !== artifact.ref.sha256 || ref.chunks !== artifact.ref.chunks)) ||
          (ref.status === "partial" && ref.sha256 !== null)
        )
          throw new Error("Rollout ZIP integrity: invalid artifact reference")
      }
      for (const snapshot of manifest.snapshots) validateReferences(snapshot, snapshot.owner)
      const report = SessionExport.PersistedReport.parse(JSON.parse((await bytes("transcript.json")).toString()))
      if (report.rootSessionID !== manifest.rootSessionID) throw new Error("Rollout ZIP root mismatch")
      const snapshotOwners = new Set<string>()
      for (const snapshot of manifest.fileSnapshots) {
        if (
          snapshotOwners.has(snapshot.sessionID) ||
          !report.sessions.some((session) => session.info.id === snapshot.sessionID)
        )
          throw new Error("Rollout ZIP file snapshot owner mismatch")
        snapshotOwners.add(snapshot.sessionID)
        for (const path of snapshot.packs.flat()) {
          if (!files.has(path) || payloadFiles.has(path))
            throw new Error("Rollout ZIP file snapshot file missing or reused")
          payloadFiles.add(path)
        }
      }
      for (const session of report.sessions) {
        const owner: RolloutSchema.Owner = {
          kind: "session",
          scopeID: session.info.scope.id,
          sessionID: session.info.id,
        }
        validateReferences(session, owner)
        const retained = new Set(
          manifest.fileSnapshots.find((snapshot) => snapshot.sessionID === session.info.id)?.roots,
        )
        if (
          manifest.integrity.complete &&
          session.messages.some((message) =>
            message.parts.flatMap(SnapshotRecords.partRoots).some((root) => !retained.has(root)),
          )
        )
          throw new Error("Rollout ZIP integrity: missing file snapshot")
      }
      return { reader, manifest, bytes }
    } catch (error) {
      await reader.close()
      throw error
    }
  }
  export async function inspect(blob: Blob) {
    const archive = await open(blob)
    try {
      return { manifest: archive.manifest }
    } finally {
      await archive.reader.close()
    }
  }

  export async function restore(blob: Blob): Promise<SessionImport.Result> {
    const archive = await open(blob)
    const created: RolloutSchema.Owner[] = []
    try {
      const report = SessionExport.Report.parse(JSON.parse((await archive.bytes("transcript.json")).toString()))
      SessionImport.validateScope(report)
      if (report.rootSessionID !== archive.manifest.rootSessionID) throw new Error("Rollout ZIP root mismatch")
      const ids = new Map<string, string>()
      const sessionIDs = new Map(report.sessions.map((data) => [data.info.id, Identifier.descending("session")]))
      for (const [source, local] of sessionIDs) ids.set(source, local)
      for (const data of report.sessions)
        for (const message of data.messages) {
          ids.set(message.info.id, Identifier.ascending("message"))
          for (const part of message.parts) ids.set(part.id, Identifier.ascending("part"))
        }
      for (const snapshot of archive.manifest.snapshots)
        for (const records of [
          snapshot.runs,
          snapshot.segments,
          snapshot.calls,
          snapshot.attempts,
          snapshot.tools,
          snapshot.processes,
        ])
          for (const record of records) if (!ids.has(record.id)) ids.set(record.id, crypto.randomUUID())
      const scopeID = ScopeContext.current.scope.id
      const ownerKey = (owner: RolloutSchema.Owner) => JSON.stringify(owner)
      const owners = new Map<string, RolloutSchema.Owner>()
      for (const snapshot of archive.manifest.snapshots) {
        if (snapshot.owner.kind !== "session" || !sessionIDs.has(snapshot.owner.sessionID))
          throw new Error("Rollout ZIP contains an unrelated owner")
        const owner: RolloutSchema.Owner = {
          kind: "session",
          scopeID,
          sessionID: sessionIDs.get(snapshot.owner.sessionID)!,
        }
        owners.set(ownerKey(snapshot.owner), owner)
        created.push(owner)
      }
      const artifacts = new Map<string, RolloutArtifact.Ref>()
      for (const snapshot of archive.manifest.fileSnapshots) {
        const packs = snapshot.packs.map((files) =>
          (async function* () {
            for (const file of files) yield await archive.bytes(file)
          })(),
        )
        await SnapshotArchive.importSession(sessionIDs.get(snapshot.sessionID)!, snapshot.roots, packs)
      }
      for (const artifact of archive.manifest.artifacts) {
        const owner = owners.get(ownerKey(artifact.owner))
        if (!owner) throw new Error("Rollout ZIP artifact owner mismatch")
        const writer = await RolloutArtifact.open(owner, artifact.ref.mediaType)
        for (const file of artifact.files) {
          await writer.append(await archive.bytes(file))
          await writer.checkpoint()
        }
        const ref = await writer.finish(artifact.ref.status)
        artifacts.set(`${ownerKey(artifact.owner)}:${artifact.ref.id}`, ref)
      }
      const missingArtifacts = new Set<string>()
      for (const snapshot of archive.manifest.snapshots) {
        const refs = references(snapshot)
        const transcript = report.sessions.find(
          (session) => snapshot.owner.kind === "session" && session.info.id === snapshot.owner.sessionID,
        )
        if (transcript) references(transcript, refs)
        for (const ref of refs.values()) {
          const key = `${ownerKey(snapshot.owner)}:${ref.id}`
          if (artifacts.has(key)) continue
          const writer = await RolloutArtifact.open(owners.get(ownerKey(snapshot.owner))!, ref.mediaType)
          artifacts.set(key, await writer.finish("partial"))
          missingArtifacts.add(key)
        }
      }
      function remap(value: unknown, sourceOwner: RolloutSchema.Owner): unknown {
        if (typeof value === "string") return ids.get(value) ?? value
        if (!value || typeof value !== "object") return value
        const ref = RolloutArtifact.Ref.safeParse(value)
        if (ref.success) {
          const key = `${ownerKey(sourceOwner)}:${ref.data.id}`
          const copied = artifacts.get(key)
          if (!copied) throw new Error("Rollout ZIP integrity: unresolved artifact owner")
          return missingArtifacts.has(key) ? copied : { ...ref.data, id: copied.id }
        }
        const owner = RolloutSchema.Owner.safeParse(value)
        if (owner.success) return owners.get(ownerKey(owner.data)) ?? value
        if (Array.isArray(value)) return value.map((entry) => remap(entry, sourceOwner))
        return Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [key, key === "source" ? entry : remap(entry, sourceOwner)]),
        )
      }
      for (const snapshot of archive.manifest.snapshots) {
        const owner = owners.get(ownerKey(snapshot.owner))!
        const root = RolloutArtifact.root(owner)
        for (const records of [
          snapshot.runs,
          snapshot.segments,
          snapshot.calls,
          snapshot.attempts,
          snapshot.tools,
          snapshot.processes,
        ]) {
          for (const record of records) {
            const value = remap(record, snapshot.owner) as typeof record
            if (value.status === "running") {
              value.status = "interrupted"
              value.ended = archive.manifest.exportedAt
            }
            const runID = "runID" in value ? value.runID : value.id
            let key: string[]
            if (records === snapshot.runs) {
              key = ["info"]
              Object.assign(value, {
                source: { owner: snapshot.owner, runID: record.id },
                cancelRequestedAt: undefined,
              })
            } else if (records === snapshot.attempts)
              key = ["attempts", (value as RolloutSchema.AttemptRecord).callID, value.id]
            else {
              const kind =
                records === snapshot.calls
                  ? "calls"
                  : records === snapshot.tools
                    ? "tools"
                    : records === snapshot.processes
                      ? "processes"
                      : "segments"
              key = [kind, value.id]
              if (kind === "calls")
                Object.assign(value, {
                  source: (record as RolloutSchema.CallRecord).source ?? {
                    owner: snapshot.owner,
                    runID: (record as RolloutSchema.CallRecord).runID,
                    callID: record.id,
                  },
                })
            }
            await RolloutJournal.write(owner, [...root, "runs", runID, ...key], value)
          }
        }
        const evidence = archive.manifest.files.filter(
          (file) =>
            file.path.startsWith(`sessions/${snapshot.owner.kind === "session" ? snapshot.owner.sessionID : ""}/`) ||
            (file.path.startsWith(`owners/${archive.manifest.snapshots.indexOf(snapshot)}/`) &&
              !file.path.includes("/artifacts/")),
        )
        const sourceEvidence = []
        for (const file of evidence)
          sourceEvidence.push({
            path: file.path,
            artifact: await RolloutArtifact.writeText(
              owner,
              (await archive.bytes(file.path)).toString(),
              "application/vnd.synergy.source-evidence+json",
            ),
          })
        await Storage.write(
          [...root, "import"],
          {
            version: 1,
            source: snapshot.owner,
            revision: snapshot.revision,
            integrity: archive.manifest.integrity,
            evidence: sourceEvidence,
            artifacts: [...artifacts.entries()].map(([source, ref]) => ({ source, ref })),
          },
          { private: true, durable: true },
        )
      }
      for (const data of report.sessions) {
        const owner: RolloutSchema.Owner = { kind: "session", scopeID: data.info.scope.id, sessionID: data.info.id }
        data.messages = data.messages.map((message) => {
          const mapped = remap(message, owner) as typeof message
          if (mapped.info.role === "assistant")
            mapped.info.accounting = {
              kind: "imported",
              source: {
                sessionID: data.info.id,
                messageID: message.info.id,
                callIDs:
                  message.info.role === "assistant" && message.info.accounting?.kind === "rollout"
                    ? message.info.accounting.callIDs
                    : [],
              },
            }
          return mapped
        })
        for (const message of data.messages)
          for (const part of message.parts) {
            const attachments =
              part.type === "attachment"
                ? [part]
                : part.type === "tool" && part.state.status === "completed"
                  ? (part.state.attachments ?? [])
                  : []
            for (const attachment of attachments)
              if (attachment.artifact?.status === "complete") {
                attachment.url = await RolloutAttachment.materialize(
                  { kind: "session", scopeID, sessionID: sessionIDs.get(data.info.id)! },
                  attachment.artifact,
                )
                attachment.localPath = undefined
              }
          }
        SessionSchemaRegistry.normalizeImport(data.info, "archive")
      }
      const result = await SessionImport.fromReport(report, { sessionIDs, rollout: true })
      result.warnings.push(...archive.manifest.integrity.missing)
      if (!archive.manifest.integrity.complete) result.warnings.push("Imported rollout is a partial evidence snapshot.")
      return result
    } catch (error) {
      for (const owner of created) {
        if (owner.kind === "session") {
          await Session.remove(owner.sessionID).catch(() => {})
          await Storage.removeTree(RolloutArtifact.root(owner))
          await SnapshotLifecycle.beginDelete(owner.scopeID, owner.sessionID)
          await SnapshotLifecycle.completeDelete(owner.scopeID, owner.sessionID)
        }
      }
      throw error
    } finally {
      await archive.reader.close()
    }
  }
}
