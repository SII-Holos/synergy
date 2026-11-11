import { z } from "zod"
import { Session } from "."
import { Storage } from "../storage/storage"
import { Scope } from "../scope"
import { ScopeContext } from "../scope/context"
import { SessionTransferOwners as Owners } from "./transfer-owners"
import { SessionTransferEpochs as Epochs } from "./transfer-epochs"
import { SessionManager } from "./manager"
import { LoopJob } from "./loop-job"
import { SessionCompat } from "./compat-import"
import { SessionSchemaRegistry } from "./schema-registry"
import { SessionRecords } from "./records"
import { SessionMessageCache } from "./message-cache"
import { WorkspaceTransfer } from "./workspace-transfer"
import { WorkspaceCatalog } from "../workspace"
import { MessageV2 } from "./message-v2"
import { Bus } from "../bus"
import { SessionEvent } from "./event"
import type { SessionTransferStream } from "./transfer-stream"
import { SessionTransferReferences } from "./transfer-references"
import { PartContent } from "./part-content"
import { RolloutArtifact } from "./rollout/artifact"
import { SnapshotRecords } from "./snapshot-records"
import { RolloutSchema } from "./rollout/schema"
import { RolloutEvidence } from "./rollout/evidence"
import { SnapshotEvidence } from "./snapshot-evidence"

export namespace SessionTransferCore {
  const Mapping = z.object({
    workspaceIDs: z.record(z.string(), z.string()).default({}),
    environmentID: z.string().nullable().default(null),
  })
  const own = (session: Readonly<Session.Info>, key: readonly string[]) =>
    (key.length >= 4 &&
      key[0] === "sessions" &&
      key[1] === session.scope.id &&
      key[2] === session.id &&
      key[3] !== "lightloop_terminal") ||
    (key.length >= 3 && key[0] === "usage" && key[1] === session.scope.id && key[2] === `session_${session.id}`)
  const infoKey = (session: Readonly<Session.Info>) => ["sessions", session.scope.id, session.id, "info"]
  const isInfo = (session: Readonly<Session.Info>, key: string[]) =>
    JSON.stringify(key) === JSON.stringify(infoKey(session))
  const json = (value: unknown) =>
    (async function* () {
      yield new TextEncoder().encode(JSON.stringify(value))
    })()
  function fail(message: string): never {
    throw new Owners.Rejected({ message })
  }

  async function* children(session: Readonly<Session.Info>) {
    let cursor: Parameters<typeof Session.childPage>[0]["cursor"]
    for (;;) {
      const page = await ScopeContext.provide({
        scope: session.scope,
        workspace: null,
        fn: () => Session.childPage({ parentID: session.id, cursor, limit: 50, includeArchived: true }),
      })
      for (const child of page.items) yield child.id
      if (!page.nextCursor) return
      cursor = page.nextCursor
    }
  }

  async function* records(session: Readonly<Session.Info>) {
    for (const prefix of [
      ["sessions", session.scope.id, session.id],
      ["usage", session.scope.id, `session_${session.id}`],
    ])
      for await (const row of Storage.records({ prefix, limit: 128 })) if (own(session, row.key)) yield row
  }

  export async function* snapshotRoots(session: Readonly<Session.Info>, records: AsyncIterable<Owners.StagedRecord>) {
    let infos = 0
    for await (const record of records) {
      if (!own(session, record.key)) fail("Snapshot root evidence belongs to another core Session")
      if (isInfo(session, record.key)) {
        parseInfo(session, record.value)
        infos++
      }
      if (record.key.length === 7 && record.key[3] === "messages" && record.key[5] === "parts") {
        if (infos !== 1) fail("Snapshot roots require prior canonical Session metadata")
        yield* SnapshotRecords.partRoots(record.value)
      }
    }
    if (infos !== 1) fail("Snapshot root evidence requires one canonical core Session record")
  }

  async function inspect(context: Owners.SourceContext): Promise<Owners.Inspection> {
    const requirements: Owners.Requirement[] = []
    for await (const row of records(context.session)) {
      context.signal.throwIfAborted()
      if (row.key[3] !== "messages") continue
      if (row.key[5] === "info") {
        const message = MessageV2.Info.parse(row.value)
        for (const owner of MessageV2.requiredOwners(message))
          requirements.push(...Owners.compatibility({ [owner]: 1 }))
      }
      if (row.key[5] === "parts" && SnapshotRecords.partRoots(row.value).length)
        requirements.push(...Owners.compatibility({ "session-snapshots": 1 }))
      const tool = z.object({ type: z.literal("tool"), state: z.object({ status: z.string() }) }).safeParse(row.value)
      if (tool.success && ["pending", "generating", "running"].includes(tool.data.state.status)) {
        requirements.push({
          code: "tool_unsettled",
          owner: "session-core",
          label: "Drain the pending native tool and reconcile its operation before transfer",
          recoverable: true,
        })
        break
      }
    }
    return { requirements, children: children(context.session) }
  }

  function parseInfo(session: Readonly<Session.Info>, value: unknown) {
    const raw = z.record(z.string(), z.unknown()).parse(value)
    const info = Session.PersistedInfo.parse({ ...raw, workspace: null })
    if (info.id !== session.id || info.scope.id !== session.scope.id || info.parentID !== session.parentID)
      fail("Portable Session metadata belongs to another owner")
    return { raw, info }
  }

  async function sourceInfo(context: Owners.TargetContext) {
    const record = await context.staged.record(infoKey(context.session))
    if (!record) fail("Portable Session metadata is absent")
    return parseInfo(context.session, record.value)
  }

  function map(context: Owners.TargetContext, key: string[], value: unknown) {
    const mapping = Mapping.parse(context.mapping)
    const mapped = WorkspaceTransfer.record(key, value, (reference) => {
      const workspaceID = Object.hasOwn(mapping.workspaceIDs, reference.id)
        ? mapping.workspaceIDs[reference.id]
        : undefined
      if (!workspaceID || reference.scopeID !== context.session.scope.id)
        fail("Portable history requires an explicit destination mapping for every Workspace")
      return workspaceID
    })
    return key.length === 6 && key[0] === "sessions" && key[3] === "messages" && key[5] === "info"
      ? SnapshotEvidence.portable(mapped)
      : mapped
  }

  async function validate(context: Owners.TargetContext) {
    await sourceInfo(context)
    let infos = 0
    for await (const record of context.staged.records()) {
      context.signal.throwIfAborted()
      if (!own(context.session, record.key)) fail("Portable core contains another owner's records")
      if (isInfo(context.session, record.key)) infos++
      map(context, record.key, record.value)
    }
    if (infos !== 1) fail("Portable core metadata is missing or duplicated")
    for await (const artifact of context.staged.artifacts())
      if (!own(context.session, artifact.key) || artifact.key[0] !== "sessions")
        fail("Portable core contains another owner's binary artifacts")
  }

  async function* dependencies(context: Owners.SourceContext): AsyncGenerator<Owners.Dependency> {
    for await (const record of records(context.session)) {
      context.signal.throwIfAborted()
      if (
        record.key.length === 8 &&
        record.key[3] === "rollout" &&
        record.key[4] === "runs" &&
        record.key[6] === "tools"
      ) {
        const tool = RolloutSchema.ToolExecutionRecord.parse(record.value)
        const owner = { kind: "session" as const, scopeID: context.session.scope.id, sessionID: context.session.id }
        if (
          tool.id !== record.key[7] ||
          tool.runID !== record.key[5] ||
          JSON.stringify(RolloutArtifact.root(tool.owner)) !== JSON.stringify(RolloutArtifact.root(owner))
        )
          fail("Portable tool evidence has another native owner")
        for (const source of RolloutEvidence.sources({ kind: "tool", value: tool })) {
          if (
            source.artifact.status !== "complete" ||
            source.artifact.mediaType.split(";")[0].toLowerCase() !== "application/json"
          )
            continue
          let body = ""
          const decoder = new TextDecoder("utf-8", { fatal: true })
          for await (const block of RolloutArtifact.read(owner, source.artifact)) {
            context.signal.throwIfAborted()
            body += decoder.decode(block, { stream: true })
          }
          body += decoder.decode()
          const value: unknown = JSON.parse(body)
          if (source.field === "input") yield* SessionTransferReferences.value(value)
          else yield* SessionTransferReferences.result(value)
        }
      }
      if (record.key[3] !== "messages" || record.key[5] !== "parts") {
        yield* SessionTransferReferences.value(record.value)
        continue
      }
      const part = record.value as PartContent.Stored
      if (
        part.type === "tool" &&
        part.state.status === "completed" &&
        part.state.outputArtifact?.status === "complete" &&
        part.state.metadata.rolloutImportMissingOutput !== true &&
        part.state.metadata.rolloutLegacyOutput !== "missing"
      ) {
        const { outputPath: _historicalPath, ...metadata } = part.state.metadata
        yield* SessionTransferReferences.value({ ...part, state: { ...part.state, metadata } })
      } else yield* SessionTransferReferences.value(part)
      if (part.type === "text" || part.type === "reasoning") {
        let body = ""
        for await (const block of PartContent.textBlocks(record.key, part, context.signal)) body += block
        yield* SessionTransferReferences.markdown(body)
      } else if (part.type === "compaction_recovery") yield* SessionTransferReferences.markdown(part.summary)
      else if (part.type === "tool") {
        const state = part.state
        if (state.status !== "completed") continue
        const reference = state.metadata.outputPath
        if (
          !state.outputArtifact ||
          state.metadata.rolloutImportMissingOutput === true ||
          state.metadata.rolloutLegacyOutput === "missing"
        ) {
          if (typeof reference === "string") yield { kind: "tool-output", reference }
          yield* SessionTransferReferences.markdown(state.output)
          continue
        }
        let output = ""
        const decoder = new TextDecoder()
        for await (const block of RolloutArtifact.read(
          { kind: "session", scopeID: context.session.scope.id, sessionID: context.session.id },
          state.outputArtifact,
        )) {
          context.signal.throwIfAborted()
          output += decoder.decode(block, { stream: true })
        }
        output += decoder.decode()
        yield* SessionTransferReferences.markdown(output)
      }
    }
  }

  async function scope(source: Scope) {
    if (source.type === "home") return Scope.home()
    const existing = await Scope.fromID(source.id)
    if (existing) return existing
    return Scope.registerProject({ ...source, local: null })
  }

  async function publish(context: Owners.TargetContext) {
    Epochs.assertActivation({ sessionID: context.session.id, handoffID: context.handoffID })
    await validate(context)
    const source = await sourceInfo(context)
    const targetScope = await scope(source.info.scope)
    const mapped = z.record(z.string(), z.unknown()).parse(map(context, infoKey(context.session), source.raw))
    const raw = {
      ...mapped,
      scope: targetScope,
      workspace: null,
      environmentID: Mapping.parse(context.mapping).environmentID,
      permission: [],
      preAuthorizedActions: [],
      endpoint: undefined,
    }
    const next = Session.PersistedInfo.parse(raw)
    const [previous] = await Storage.readMany([infoKey(context.session)])
    const parent = next.parentID ? await Session.get(next.parentID) : undefined
    await SessionSchemaRegistry.validateMutation({
      previous: previous === undefined ? undefined : z.record(z.string(), z.unknown()).parse(previous),
      next: raw,
      parent,
    })
    if (next.workspaceID) await WorkspaceCatalog.assertActive(next.workspaceID, next.scope.id)
    const { workspace: _workspace, ...persisted } = raw
    await Storage.removeTree(["sessions", next.scope.id, next.id])
    await Storage.removeTree(["usage", next.scope.id, `session_${next.id}`])
    await Storage.write(infoKey(context.session), persisted)
    for await (const record of context.staged.records())
      if (!isInfo(context.session, record.key)) await Storage.write(record.key, map(context, record.key, record.value))
    for await (const artifact of context.staged.artifacts()) await artifact.publish(artifact.key, { replace: true })
    await SessionCompat.writeSessionIndexes({ scopeID: next.scope.id, sessionID: next.id })
    Storage.afterCommit(() => {
      SessionManager.registerRuntime(next.id)
      SessionMessageCache.invalidate(next.id)
    })
    const hydrated = await SessionRecords.hydrate(Session.Info.parse({ ...next, workspace: null }))
    await ScopeContext.provide({
      scope: targetScope,
      workspace: hydrated.workspace,
      fn: () => Bus.publish(SessionEvent.Updated, { info: Session.publicInfo(hydrated) }),
    })
  }

  export function register() {
    Owners.register("session-core", {
      version: 1,
      reads: [1],
      applies: () => true,
      inspect,
      async freeze(context) {
        await SessionManager.waitForIdle(context.session.id, context.signal)
        if (SessionManager.isRunning(context.session.id) || LoopJob.activeBackgroundCount(context.session.id))
          fail("Portable core still has native background execution")
        await Session.flushPartWrites(context.session.id)
        const result = await inspect({ ...context, session: await Session.get(context.session.id) })
        if (result.requirements.length)
          throw new Owners.Rejected({ message: "Portable core is not drained", requirements: result.requirements })
      },
      async *export(context): AsyncGenerator<SessionTransferStream.Input> {
        const session = await Session.get(context.session.id)
        for await (const row of records(session))
          yield {
            id: JSON.stringify(["session-core", "record", row.key]),
            kind: "record",
            metadata: { key: row.key },
            content: json(row.value),
          }
        let after: string[] | undefined
        for (;;) {
          const page = await Storage.artifactReferences({
            prefix: ["sessions", session.scope.id, session.id],
            after,
            limit: 128,
          })
          for (const artifact of page) {
            if (!own(session, artifact.key)) fail("Portable core binary owner changed")
            yield {
              id: JSON.stringify(["session-core", "artifact", artifact.key]),
              kind: "artifact",
              metadata: { key: artifact.key },
              content: Storage.readBinaryStream(artifact.key, { signal: context.signal }),
            }
          }
          if (page.length < 128) return
          after = page.at(-1)!.key
        }
      },
      dependencies,
      validate,
      publish,
    })
  }
}
