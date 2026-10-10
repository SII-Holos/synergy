import fs from "node:fs/promises"
import path from "node:path"
import { randomBytes, randomUUID } from "node:crypto"
import { z } from "zod"
import { AssetReference } from "@ericsanchezok/synergy-util/asset-reference"
import { Storage } from "../storage/storage"
import { Scope } from "../scope"
import { ScopeContext } from "../scope/context"
import { Lock } from "../util/lock"
import { Installation } from "../global/installation"
import { RuntimeComponents } from "../lifecycle/components"
import { Bus } from "../bus"
import { SessionEvent } from "./event"
import { Session } from "."
import { SessionManager } from "./manager"
import { SessionInteraction } from "./interaction"
import { SessionExecutionContributions } from "./execution-contributions"
import { SessionCompat } from "./compat-import"
import { SessionTransferSchema as S } from "./transfer-schema"
import { SessionTransferGate as Gate } from "./transfer-gate"
import { SessionTransferArchive as Archive } from "./transfer-archive"
import { SessionTransferWorkspace } from "./transfer-workspace"
import { SessionTransferDependencies } from "./transfer-dependencies"
import { SnapshotLifecycle } from "./snapshot-lifecycle"
import { SnapshotStore } from "./snapshot-store"
import { SnapshotRecords } from "./snapshot-records"
import { SnapshotArchive } from "./snapshot-archive"
import { LoopJob } from "./loop-job"
import { WorkspaceTransfer } from "./workspace-transfer"
import { EnvironmentExecution } from "../environment/execution"
import { MessageV2 } from "./message-v2"
import { WorkspaceBinding } from "../workspace/binding"
import { WorkspaceTree } from "../workspace/tree"
import { WorkspaceCatalog } from "../workspace/catalog"

export namespace SessionTransfer {
  export const Rejected = S.Rejected
  export const Prepare = S.Prepare
  export const Receipt = S.Receipt
  export const Cancellation = S.Cancellation
  export const Activation = S.Activation
  export const State = S.State
  export const Host = S.Host
  const Source = S.State.extend({ version: z.literal(1), secret: S.Hash, cancellationSecret: S.Hash }).strict()
  const sourceKey = (sessionID: string) => ["session_transfer_out", sessionID]
  const snapshotOwner = (id: string) => `transfer_${S.ID.parse(id).replaceAll("-", "")}`
  const targetKey = (id: string) => ["session_transfer_in", S.ID.parse(id)]
  const Target = z
    .object({
      version: z.literal(1),
      receipt: S.Receipt,
      activationHash: S.Hash,
      cancellationHash: S.Hash,
      scopeID: z.string(),
      workspaceID: z.string().optional(),
    })
    .strict()
  const optional = <T>(read: Promise<T>) =>
    read.catch((error) => {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    })

  export async function host() {
    return Storage.transaction(async () => {
      const key = ["session_transfer_host", "identity"]
      const previous = await optional(Storage.read<{ version: 1; id: string }>(key))
      const id = previous?.id ?? randomUUID()
      if (!previous) await Storage.write(key, { version: 1, id })
      return Host.parse({
        id,
        version: Installation.VERSION,
        platform: process.platform,
        components: RuntimeComponents.selected(),
      })
    })
  }

  async function publish(sessionID: string) {
    await Bus.publish(SessionEvent.Updated, { info: await Session.get(sessionID) })
  }

  export async function status(sessionID: string): Promise<S.State | undefined> {
    const state = await optional(Storage.read(sourceKey(sessionID)))
    return state ? State.parse(state) : undefined
  }

  async function eligible(sessionID: string) {
    await SessionCompat.requireImported(sessionID)
    const info = await Session.get(sessionID)
    if (!info.paused || info.time.archived) throw new Rejected({ message: "Only a paused Session can transfer" })
    if (SessionManager.isRunning(sessionID) || LoopJob.activeBackgroundCount(sessionID))
      throw new Rejected({ message: "Session transfer must wait for execution and background work to drain" })
    if (
      info.parentID ||
      info.cortex ||
      SessionInteraction.isUnattended(info.interaction) ||
      info.endpoint ||
      (await SessionExecutionContributions.isActive(info)) ||
      SessionExecutionContributions.hasContinuation(info)
    )
      throw new Rejected({ message: "Session transfer does not support delegated or domain-bound Sessions" })
    if ((await Session.children(sessionID)).length)
      throw new Rejected({ message: "Session transfer does not support child Session trees" })
    if (info.workflow || (info as Record<string, unknown>).loopID)
      throw new Rejected({ message: "Session transfer does not support a bound workflow" })
    const messages = await Session.messages({ sessionID, raw: true })
    const sources = WorkspaceTransfer.sources([
      { info, messages, dag: [], todos: [], diffs: await Session.diff(sessionID) },
    ])
    if (sources.some((source) => source.id !== info.workspaceID))
      throw new Rejected({
        message: "Session transfer requires one Workspace across current selection and file history",
      })
    for (const message of messages)
      for (const part of message.parts) {
        if (
          part.type === "tool" &&
          (MessageV2.isUnsettledToolState(part.state) ||
            (part.state.status === "error" && part.state.error === MessageV2.INTERRUPTED_TOOL_ERROR))
        )
          throw new Rejected({ message: "Session transfer has unfinished tool effects" })
        if (part.type === "tool" && /browser|computer/.test(part.tool))
          throw new Rejected({ message: "Session transfer cannot preserve device-bound Browser or Computer state" })
        if (part.type === "attachment" && part.localPath && !part.artifact && !AssetReference.parse(part.url))
          throw new Rejected({ message: "Session transfer has an attachment without durable bytes" })
      }
    if (info.workspaceID) {
      const workspace = await WorkspaceCatalog.get(info.workspaceID, info.scope.id)
      if (
        workspace.activeMount ||
        (workspace.backend?.provider && workspace.backend.provider !== "directory") ||
        workspace.sharedWritableWorkspaceIDs.length
      )
        throw new Rejected({ message: "Session transfer requires an unshared native directory Workspace" })
      SessionTransferWorkspace.get()
    }
    if (
      info.environmentID &&
      (await EnvironmentExecution.listActive(info.scope.id)).some(
        (operation) => operation.target.environmentID === info.environmentID,
      )
    )
      throw new Rejected({ message: "Session transfer must settle Environment operations first" })
    return info
  }

  export async function prepare(sessionID: string, request: z.infer<typeof Prepare>) {
    request = Prepare.parse(request)
    using control = await Lock.write(`session-control:${sessionID}`)
    using transfer = await Lock.write(`session-transfer:${sessionID}`)
    const previous = await optional(Storage.read<z.infer<typeof Source>>(sourceKey(sessionID)))
    if (previous && previous.phase !== "cancelled") {
      if (previous.migrationID !== request.migrationID || previous.targetID !== request.targetID)
        throw new Rejected({ message: "A different Session transfer already owns this Session" })
      if (previous.phase !== "preparing") return State.parse(previous)
    }
    const info = await eligible(sessionID)
    await Session.flushPartWrites(sessionID)
    const identity = await host()
    if (identity.id === request.targetID)
      throw new Rejected({ message: "Session transfer destination is the source Host" })
    const state =
      previous?.phase === "preparing"
        ? previous
        : Source.parse({
            version: 1,
            ...request,
            sessionID,
            sourceID: identity.id,
            phase: "preparing",
            secret: randomBytes(32).toString("hex"),
            cancellationSecret: randomBytes(32).toString("hex"),
          })
    await Storage.transaction(async () => {
      if (SessionManager.isRunning(sessionID) || LoopJob.activeBackgroundCount(sessionID))
        throw new Rejected({ message: "Session transfer must wait for execution to drain" })
      await Storage.write(sourceKey(sessionID), state)
      await Storage.write(Gate.key(sessionID), {
        version: 1,
        migrationID: state.migrationID,
        scopeID: info.scope.id,
        targetID: state.targetID,
        phase: "preparing",
      })
    })
    try {
      await capture(info, state, identity)
      const digest = await Archive.digest(Bun.file(Archive.filename(state.migrationID)))
      await Storage.transaction(async () => {
        state.phase = "prepared"
        state.digest = digest
        state.error = undefined
        await Storage.write(sourceKey(sessionID), state)
        await Storage.write(Gate.key(sessionID), {
          version: 1,
          migrationID: state.migrationID,
          scopeID: info.scope.id,
          targetID: state.targetID,
          phase: "prepared",
        })
      })
      await publish(sessionID)
      return State.parse(state)
    } catch (error) {
      await Storage.update<z.infer<typeof Source>>(sourceKey(sessionID), (state) => {
        state.error = error instanceof Error ? error.message : "Transfer preparation failed"
      })
      throw error
    }
  }

  async function capture(info: Session.Info, state: z.infer<typeof Source>, identity: z.infer<typeof Host>) {
    const prefix = ["sessions", info.scope.id, info.id]
    const records = await Storage.snapshot(async () => {
      const result: Array<z.infer<typeof S.Record>> = []
      for await (const { key, value } of Storage.records({ prefix })) result.push({ key, value })
      for await (const { key, value } of Storage.records({ prefix: ["usage", info.scope.id, `session_${info.id}`] }))
        result.push({ key, value })
      return result
    })
    const dependencies = await SessionTransferDependencies.capture(records)
    records.push(...dependencies.records)
    const manifest: Omit<S.Manifest, "files"> = {
      format: "synergy-session-transfer",
      version: 1,
      migrationID: state.migrationID,
      sessionID: info.id,
      source: identity,
      targetID: state.targetID,
      activationHash: Archive.hash(state.secret),
      cancellationHash: Archive.hash(state.cancellationSecret),
      scope: info.scope,
      records: [],
      artifacts: [],
      snapshots: { roots: [], packs: [] },
    }
    const write = async (workspace?: {
      info: WorkspaceCatalog.Info
      tree: WorkspaceTree.Manifest
      chunks: Map<string, string>
    }) =>
      Archive.write(state.migrationID, manifest, async (add) => {
        for (let index = 0; index < records.length; index += 256) {
          const name = `records/${index}.json`
          manifest.records.push(name)
          await add(name, Buffer.from(JSON.stringify(records.slice(index, index + 256))))
        }
        const binaries = await Storage.snapshot(async (tx) => {
          const result: string[][] = []
          for await (const entry of tx.artifacts(prefix)) result.push(entry.key)
          return [...new Map(result.map((key) => [JSON.stringify(key), key])).values()]
        })
        for (const [index, key] of binaries.entries()) {
          const name = `artifacts/${index}.bin`
          await add(name, await Storage.readBinary(key, { maxBytes: 64 * 1024 * 1024 }))
          manifest.artifacts.push({ key, file: name })
        }
        for (const [index, dependency] of dependencies.artifacts.entries()) {
          const name = `dependencies/${index}.bin`
          await add(name, dependency.bytes)
          manifest.artifacts.push({ key: dependency.key, file: name })
        }
        if (workspace) {
          manifest.workspace = { info: workspace.info, tree: workspace.tree, chunks: [] }
          for (const [hash, bytes] of workspace.chunks) {
            const name = `workspace/${hash}.bin`
            await add(name, new Uint8Array(await Bun.file(bytes).arrayBuffer()))
            manifest.workspace.chunks.push({ hash, file: name })
          }
        }
        const roots = await SnapshotRecords.historicalRoots(info.scope.id, info.id)
        if (!roots.length) return
        const exported = await SnapshotArchive.exportSession(info.id, roots, async (packs, retained) => {
          manifest.snapshots.roots = retained
          for (const [index, pack] of packs.entries()) {
            const name = `snapshots/${index}.pack`
            await add(name, new Uint8Array(await Bun.file(pack).arrayBuffer()))
            manifest.snapshots.packs.push(name)
          }
        })
        if (exported.missing.length)
          throw new Rejected({ message: "Session transfer is missing historical file objects" })
      })
    if (!info.workspaceID) return write()
    const chunks = new Map<string, string>()
    const cache = path.join(Archive.directory(state.migrationID), "chunks")
    await fs.mkdir(cache, { recursive: true, mode: 0o700 })
    try {
      return await SessionTransferWorkspace.get().capture(
        info.workspaceID,
        {
          async put(hash, data) {
            const file = path.join(cache, WorkspaceTree.Hash.parse(hash))
            if (!chunks.has(hash)) {
              await Bun.write(file, data)
              chunks.set(hash, file)
            }
          },
          async get(hash, maximum) {
            const file = chunks.get(hash)
            if (!file) throw new Rejected({ message: "Missing Workspace transfer object" })
            return WorkspaceTree.verify(hash, new Uint8Array(await Bun.file(file).arrayBuffer()), maximum)
          },
        },
        (info, tree) => write({ info, tree, chunks }),
      )
    } finally {
      await fs.rm(cache, { recursive: true, force: true })
    }
  }

  export async function archive(sessionID: string) {
    const state = Source.parse(await Storage.read(sourceKey(sessionID)))
    if (!state.digest || state.phase === "cancelled")
      throw new Rejected({ message: "Session transfer payload is not prepared" })
    const file = Bun.file(Archive.filename(state.migrationID))
    if ((await Archive.digest(file)) !== state.digest)
      throw new Rejected({ message: "Frozen Session transfer payload changed" })
    return file
  }

  async function records(archive: Awaited<ReturnType<typeof Archive.open>>) {
    const entries: Array<z.infer<typeof S.Record>> = []
    for (const file of archive.manifest.records)
      entries.push(...z.array(S.Record).parse(JSON.parse((await archive.bytes(file)).toString())))
    const m = archive.manifest
    const own = (key: string[]) =>
      (key[0] === "sessions" && key[1] === m.scope.id && key[2] === m.sessionID) ||
      (key[0] === "usage" && key[1] === m.scope.id && key[2] === `session_${m.sessionID}`)
    const extra = new Set(
      SessionTransferDependencies.keys(
        entries.filter((entry) => own(entry.key)),
        entries,
      ).map((key) => JSON.stringify(key)),
    )
    const unique = new Set<string>()
    for (const { key } of entries) {
      const id = JSON.stringify(key)
      if (unique.has(id) || (!own(key) && !extra.has(id)))
        throw new Rejected({ message: "Session transfer contains unrelated or duplicate records" })
      unique.add(id)
    }
    const artifactKeys = new Set<string>()
    for (const { key } of m.artifacts) {
      const id = JSON.stringify(key)
      if (artifactKeys.has(id)) throw new Rejected({ message: "Session transfer contains duplicate artifacts" })
      artifactKeys.add(id)
      if (
        (key[0] === "assets" && key.length !== 2) ||
        (key[0] === "tool_outputs" && (key.length !== 3 || key[2] !== "content"))
      )
        throw new Rejected({ message: "Session transfer has an invalid dependency artifact key" })
      const metadata =
        key[0] === "assets"
          ? ["asset_manifest", key[1]]
          : key[0] === "tool_outputs"
            ? ["tool_outputs", key[1], "info"]
            : key
      if (!own(key) && !extra.has(JSON.stringify(metadata)))
        throw new Rejected({ message: "Session transfer contains unrelated artifact authority" })
    }
    for (const key of extra) {
      if (!unique.has(key)) throw new Rejected({ message: "Session transfer is missing dependency metadata" })
      const metadata = JSON.parse(key) as string[]
      if (metadata[0] === "tool_output_aliases") continue
      const artifact =
        metadata[0] === "asset_manifest" ? ["assets", metadata[1]] : ["tool_outputs", metadata[1], "content"]
      if (!artifactKeys.has(JSON.stringify(artifact)))
        throw new Rejected({ message: "Session transfer is missing dependency bytes" })
    }
    const rawInfo = entries.find(
      (entry) => JSON.stringify(entry.key) === JSON.stringify(["sessions", m.scope.id, m.sessionID, "info"]),
    )?.value
    const info = Session.PersistedInfo.parse({ ...(rawInfo as Record<string, unknown>), workspace: null })
    if (
      info.id !== m.sessionID ||
      info.scope.id !== m.scope.id ||
      !info.paused ||
      info.parentID ||
      info.cortex ||
      info.endpoint
    )
      throw new Rejected({ message: "Session transfer manifest owner is invalid" })
    if (
      info.workflow ||
      SessionInteraction.isUnattended(info.interaction) ||
      SessionExecutionContributions.hasContinuation(info) ||
      !!info.workspaceID !== !!m.workspace ||
      (m.workspace && (info.workspaceID !== m.workspace.info.id || m.workspace.info.scopeID !== m.scope.id))
    )
      throw new Rejected({ message: "Session transfer has unsupported destination state" })
    for (const entry of entries)
      WorkspaceTransfer.record(entry.key, entry.value, (reference) => {
        if (reference.id !== m.workspace?.info.id || reference.scopeID !== m.scope.id)
          throw new Rejected({ message: "Session transfer has an unmapped Workspace" })
        return reference.id
      })
    for (const artifact of m.artifacts) {
      if (!["assets", "tool_outputs"].includes(artifact.key[0])) continue
      const metadata =
        artifact.key[0] === "assets" ? ["asset_manifest", artifact.key[1]] : ["tool_outputs", artifact.key[1], "info"]
      const value = entries.find((entry) => JSON.stringify(entry.key) === JSON.stringify(metadata))?.value
      const info = z.object({ bytes: z.number().int().nonnegative(), sha256: S.Hash }).parse(value)
      const data = await archive.bytes(artifact.file)
      if (
        artifact.key[0] === "assets" &&
        (!AssetReference.isValidId(artifact.key[1]!) || !info.sha256.startsWith(artifact.key[1]!.split(".")[0]!))
      )
        throw new Rejected({ message: "Session transfer asset identifier mismatch" })
      if (data.length !== info.bytes || Archive.hash(data) !== info.sha256)
        throw new Rejected({ message: "Session transfer dependency integrity check failed" })
    }
    for (const entry of entries.filter((entry) => entry.key[0] !== "sessions")) {
      const previous = await optional(Storage.read(entry.key))
      if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(entry.value))
        throw new Rejected({ message: "Session transfer evidence collides with destination data" })
    }
    return entries
  }

  async function targetScope(scope: S.Manifest["scope"]) {
    const existing = await Scope.fromID(scope.id)
    if (existing) return existing
    if (scope.type !== "project") throw new Rejected({ message: "Missing target Scope" })
    return { ...scope, local: null }
  }

  export async function stage(blob: Blob): Promise<S.Receipt> {
    await using archive = await Archive.open(blob)
    const m = archive.manifest
    using transfer = await Lock.write(`session-transfer-receive:${m.migrationID}`)
    const identity = await host()
    if (
      m.targetID !== identity.id ||
      m.source.id === identity.id ||
      m.source.platform !== identity.platform ||
      m.source.version !== identity.version ||
      JSON.stringify(m.source.components) !== JSON.stringify(identity.components)
    )
      throw new Rejected({ message: "Session transfer destination platform, version or components do not match" })
    const digest = await Archive.digest(blob)
    const previous = await optional(Storage.read<z.infer<typeof Target>>(targetKey(m.migrationID)))
    if (previous) {
      if (previous.receipt.digest !== digest)
        throw new Rejected({ message: "Session transfer retry changed its payload" })
      return previous.receipt
    }
    await archive.verify()
    await records(archive)
    await SessionTransferDependencies.assets(archive)
    const scope = await targetScope(m.scope)
    const receipt = Receipt.parse({
      migrationID: m.migrationID,
      sessionID: m.sessionID,
      sourceID: m.source.id,
      targetID: identity.id,
      digest,
      phase: "prepared",
    })
    const target = Target.parse({
      version: 1,
      receipt,
      activationHash: m.activationHash,
      cancellationHash: m.cancellationHash,
      scopeID: m.scope.id,
    })
    await Storage.transaction(async () => {
      const [index, reserved] = await Storage.readMany<{ migrationID: string; receipt: S.Receipt }>([
        ["session_index", m.sessionID],
        Gate.reservationKey(m.sessionID),
      ])
      if (index || (reserved && (reserved.migrationID !== m.migrationID || reserved.receipt.digest !== digest)))
        throw new Rejected({ message: "Session transfer destination already owns this identity" })
      await Storage.write(Gate.reservationKey(m.sessionID), { ...target, migrationID: m.migrationID })
    })
    if (m.workspace) {
      const chunks = new Map(m.workspace.chunks.map((chunk) => [chunk.hash, chunk.file]))
      await SessionTransferWorkspace.get().materialize(m.migrationID, m.workspace.tree, {
        async get(hash, maximum) {
          const name = chunks.get(hash)
          if (!name) throw new Rejected({ message: "Missing Workspace object" })
          return WorkspaceTree.verify(hash, await archive.bytes(name), maximum)
        },
        async put() {
          throw new Rejected({ message: "Transfer Workspace is read only" })
        },
      })
    }
    if (m.snapshots.roots.length)
      await ScopeContext.provide({
        scope,
        workspace: null,
        fn: () =>
          SnapshotArchive.importSession(
            snapshotOwner(m.migrationID),
            m.snapshots.roots,
            m.snapshots.packs.map((name) =>
              (async function* () {
                yield await archive.bytes(name)
              })(),
            ),
          ),
      })
    await Archive.save(m.migrationID, blob)
    await Storage.write(targetKey(m.migrationID), target)
    return receipt
  }

  export async function destination(migrationID: string) {
    return Target.parse(await Storage.read(targetKey(migrationID))).receipt
  }

  export async function discard(input: z.infer<typeof Cancellation>) {
    const proof = Cancellation.parse(input)
    const migrationID = proof.migrationID
    using transfer = await Lock.write(`session-transfer-receive:${migrationID}`)
    const target =
      (await optional(Storage.read<z.infer<typeof Target>>(targetKey(migrationID)))) ??
      (await optional(Storage.read<z.infer<typeof Target>>(Gate.reservationKey(proof.sessionID))))
    if (!target) return true
    if (target.receipt.phase === "activated")
      throw new Rejected({ message: "Activated Session transfer cannot be discarded" })
    if (
      Archive.hash(proof.secret) !== target.cancellationHash ||
      ["migrationID", "sessionID", "sourceID", "targetID"].some(
        (key) => proof[key as keyof typeof proof] !== target.receipt[key as keyof S.Receipt],
      )
    )
      throw new Rejected({ message: "Session transfer cancellation proof does not match destination" })
    await cleanSnapshots(target.scopeID, migrationID)
    await fs.rm(Archive.directory(migrationID), { recursive: true, force: true })
    await Storage.remove(["session_transfer_workspace", migrationID])
    await Storage.transaction(async () => {
      await Storage.remove(Gate.reservationKey(target.receipt.sessionID))
      await Storage.remove(targetKey(migrationID))
    })
    return true
  }

  export async function commit(sessionID: string, input: S.Receipt): Promise<S.Activation> {
    const receipt = Receipt.parse(input)
    using transfer = await Lock.write(`session-transfer:${sessionID}`)
    const proof = await Storage.transaction(async () => {
      const state = Source.parse(await Storage.read(sourceKey(sessionID)))
      if (
        !["prepared", "committed", "completed"].includes(state.phase) ||
        receipt.phase !== "prepared" ||
        receipt.sessionID !== sessionID ||
        receipt.migrationID !== state.migrationID ||
        receipt.sourceID !== state.sourceID ||
        receipt.targetID !== state.targetID ||
        receipt.digest !== state.digest
      )
        throw new Rejected({ message: "Session transfer prepared receipt does not match frozen source" })
      if (state.phase === "prepared") {
        state.phase = "committed"
        await Storage.write(sourceKey(sessionID), state)
        await Storage.update<z.infer<typeof Gate.Info>>(Gate.key(sessionID), (gate) => {
          gate.phase = "committed"
        })
      }
      return Activation.parse({ ...receipt, secret: state.secret })
    })
    await publish(sessionID)
    return proof
  }

  export async function activate(input: S.Activation): Promise<S.Receipt> {
    const proof = Activation.parse(input)
    using transfer = await Lock.write(`session-transfer-receive:${proof.migrationID}`)
    const target = Target.parse(await Storage.read(targetKey(proof.migrationID)))
    if (
      Archive.hash(proof.secret) !== target.activationHash ||
      ["migrationID", "sessionID", "sourceID", "targetID", "digest"].some(
        (key) => proof[key as keyof S.Activation] !== target.receipt[key as keyof S.Receipt],
      )
    )
      throw new Rejected({ message: "Session transfer activation does not match prepared destination" })
    if (target.receipt.phase === "activated") {
      await cleanSnapshots(target.scopeID, proof.migrationID)
      await Archive.cleanPayload(proof.migrationID)
      return target.receipt
    }
    const blob = Bun.file(Archive.filename(proof.migrationID))
    if ((await Archive.digest(blob)) !== proof.digest)
      throw new Rejected({ message: "Prepared Session transfer payload changed" })
    await using archive = await Archive.open(blob)
    const entries = await records(archive)
    const m = archive.manifest
    const scope = await targetScope(m.scope)
    return ScopeContext.provide({
      scope,
      workspace: null,
      fn: async () => {
        const workspacePath = m.workspace ? await SessionTransferWorkspace.get().validate(proof.migrationID) : undefined
        if (m.snapshots.roots.length)
          await Gate.activating(proof.migrationID, () =>
            SnapshotLifecycle.adopt({
              scopeID: scope.id,
              sourceSessionID: snapshotOwner(proof.migrationID),
              targetSessionID: proof.sessionID,
              hashes: m.snapshots.roots,
            }),
          )
        await SessionTransferDependencies.assets(archive, true)
        const binaries: Storage.PreparedBinary[] = []
        try {
          for (const artifact of m.artifacts)
            binaries.push(await Storage.prepareBinary(artifact.key, await archive.bytes(artifact.file)))
          const receipt = await Gate.activating(proof.migrationID, () =>
            Storage.transaction(async () => {
              if (scope.type === "project" && !(await Scope.fromID(scope.id))) await Scope.registerProject(scope)
              const workspace = workspacePath ? await WorkspaceBinding.register(scope.id, workspacePath) : undefined
              const mappings = new Map(m.workspace && workspace ? [[m.workspace.info.id, workspace.id]] : [])
              await Session.create({
                id: proof.sessionID,
                scope,
                workspaceID: workspace?.id ?? null,
                workspace: workspace ? WorkspaceCatalog.projection(workspace) : null,
              })
              for (const entry of entries) {
                let value = WorkspaceTransfer.record(entry.key, entry.value, (reference) => {
                  const id = mappings.get(reference.id)
                  if (!id) throw new Rejected({ message: "Session transfer has an unmapped Workspace" })
                  return id
                })
                if (entry.key.length === 4 && entry.key[3] === "info")
                  value = {
                    ...(value as Record<string, unknown>),
                    scope,
                    environmentID: null,
                    environmentSelection: undefined,
                    permission: [],
                    preAuthorizedActions: [],
                    endpoint: undefined,
                  }
                const previous = await optional(Storage.read(entry.key))
                if (
                  entry.key[0] !== "sessions" &&
                  previous !== undefined &&
                  JSON.stringify(previous) !== JSON.stringify(value)
                )
                  throw new Rejected({ message: "Session transfer evidence collides with destination data" })
                await Storage.write(entry.key, value)
              }
              for (const binary of binaries) await Storage.publishPreparedBinary(binary)
              await Session.update(proof.sessionID, () => {}, { preserveActivityAt: true })
              const receipt = Receipt.parse({ ...target.receipt, phase: "activated" })
              await Storage.write(targetKey(proof.migrationID), { ...target, receipt, workspaceID: workspace?.id })
              await Storage.remove(Gate.reservationKey(proof.sessionID))
              return receipt
            }),
          )
          await cleanSnapshots(target.scopeID, proof.migrationID)
          await Archive.cleanPayload(proof.migrationID)
          return receipt
        } finally {
          for (const binary of binaries) binary[Symbol.dispose]()
        }
      },
    })
  }

  async function cleanSnapshots(scopeID: string, id: string) {
    const sessionID = snapshotOwner(id)
    if (!(await SnapshotStore.owner(scopeID, sessionID))) return
    await SnapshotLifecycle.beginDelete(scopeID, sessionID)
    await SnapshotLifecycle.completeDelete(scopeID, sessionID)
  }

  export async function complete(sessionID: string, input: S.Receipt) {
    const receipt = Receipt.parse(input)
    using transfer = await Lock.write(`session-transfer:${sessionID}`)
    await Storage.transaction(async () => {
      const state = Source.parse(await Storage.read(sourceKey(sessionID)))
      if (
        !["committed", "completed"].includes(state.phase) ||
        receipt.phase !== "activated" ||
        ["migrationID", "sessionID", "sourceID", "targetID", "digest"].some(
          (key) => receipt[key as keyof S.Receipt] !== state[key as keyof typeof state],
        )
      )
        throw new Rejected({ message: "Session transfer activation receipt does not match source" })
      state.phase = "completed"
      await Storage.write(sourceKey(sessionID), state)
      await Storage.update<z.infer<typeof Gate.Info>>(Gate.key(sessionID), (gate) => {
        gate.phase = "completed"
      })
    })
    await Archive.cleanPayload(receipt.migrationID)
    await publish(sessionID)
    return status(sessionID)
  }

  export async function cancel(sessionID: string) {
    using control = await Lock.write(`session-control:${sessionID}`)
    using transfer = await Lock.write(`session-transfer:${sessionID}`)
    const proof = await Storage.transaction(async () => {
      const state = Source.parse(await Storage.read(sourceKey(sessionID)))
      if (state.phase === "committed" || state.phase === "completed")
        throw new Rejected({ message: "Committed Session transfer cannot roll back; retry destination activation" })
      state.phase = "cancelled"
      await Storage.write(sourceKey(sessionID), state)
      await Storage.remove(Gate.key(sessionID))
      const proof = Cancellation.parse({
        migrationID: state.migrationID,
        sessionID,
        sourceID: state.sourceID,
        targetID: state.targetID,
        secret: state.cancellationSecret,
      })
      await Storage.write(["session_transfer_cancellation", state.migrationID], { version: 1, proof })
      return proof
    })
    await Archive.cleanPayload(proof.migrationID)
    await publish(sessionID)
    return proof
  }
}
