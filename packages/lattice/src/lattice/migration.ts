import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import type { Migration } from "@ericsanchezok/synergy-harness/migration"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { LatticeTypes } from "./types"
import { LatticeLegacyArchive as Archive } from "./legacy-archive"
import { LatticeMigrationIndex as Retained } from "./migration-index"
import { NoteTypes, NoteVersions } from "@ericsanchezok/synergy-note"
import { z } from "zod"

const log = Log.create({ service: "lattice.migration" })

const ACTIVE_LOOP_STATUSES = new Set(["armed", "running", "auditing"])

type StrictV2Index = { scopeID: string }

type LoopCandidate = {
  loopID: string
  runIDs: Set<string>
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function strictV2Run(value: unknown): LatticeTypes.Run | undefined {
  if (asRecord(value)?.schemaVersion !== 2) return undefined
  const parsed = LatticeTypes.Run.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function addLoopCandidate(candidates: Map<string, LoopCandidate>, loopID: string, runID?: string): void {
  const candidate = candidates.get(loopID) ?? { loopID, runIDs: new Set<string>() }
  if (runID) candidate.runIDs.add(runID)
  candidates.set(loopID, candidate)
}

async function readCandidate(key: string[]): Promise<unknown | undefined> {
  try {
    return await Storage.read<unknown>(key)
  } catch (error) {
    if (error instanceof Storage.NotFoundError || error instanceof SyntaxError) return undefined
    throw error
  }
}

async function removeFileVerified(key: string[], parent: string[], leaf: string, message: string): Promise<void> {
  await Storage.remove(key)
  const [remaining] = await Storage.readMany([key])
  if (remaining !== undefined) throw new Error(message)
}

async function removeTreeVerified(root: string[]): Promise<void> {
  await Storage.removeTree(root)
  for await (const _ of Storage.records({ prefix: root, limit: 1 }))
    throw new Error("Failed to remove legacy Lattice event records.")
}

function loopIDsFromRun(run: Record<string, unknown> | undefined): Set<string> {
  const result = new Set<string>()
  if (!Array.isArray(run?.pathway)) return result
  for (const value of run.pathway) {
    const loopID = asString(asRecord(value)?.blueprintLoopID)
    if (loopID) result.add(loopID)
  }
  return result
}

async function bindingReferencesStrictV2Run(
  binding: Record<string, unknown> | undefined,
  scopeID: string,
  sessionID: string,
  index: StrictV2Index,
): Promise<boolean> {
  if (!binding) return false
  const boundRunID = asString(binding.runID)
  if (!boundRunID) return false
  const retained = await Retained.retained(index.scopeID, boundRunID)
  return (
    !!retained && retained.scopeID === scopeID && (retained.sessionID === undefined || retained.sessionID === sessionID)
  )
}

async function legacyBindingMatches(
  binding: Record<string, unknown> | undefined,
  runID: string | undefined,
  index: StrictV2Index,
): Promise<boolean> {
  if (!binding) return false
  const boundRunID = asString(binding.runID)
  if (boundRunID && (await Retained.retained(index.scopeID, boundRunID))) return false
  return runID ? boundRunID === runID : true
}

async function exactLatticeLoop(
  loop: Record<string, unknown> | undefined,
  loopID: string,
  scopeID: string,
  sessionID: string,
  expectedRunIDs: Set<string>,
  index: StrictV2Index,
): Promise<boolean> {
  const ownsExecutionSession = loop?.sessionID === sessionID
  const ownsAuditSession = loop?.auditSessionID === sessionID
  if (loop?.id !== loopID || loop.scopeID !== scopeID || (!ownsExecutionSession && !ownsAuditSession)) return false
  if (await Retained.ownsLoop(index.scopeID, loopID, loop)) return false

  const source = asString(loop.source)
  const orchestration = asRecord(loop.orchestration)
  if (source && source !== "lattice") return false
  if (orchestration && orchestration.kind !== "lattice") return false
  if (!source && orchestration?.kind !== "lattice") return false

  const ownerRunID = orchestration?.kind === "lattice" ? asString(orchestration.runID) : undefined
  if (ownerRunID && !ownsAuditSession && (expectedRunIDs.size === 0 || !expectedRunIDs.has(ownerRunID))) return false
  return !ownerRunID || !(await Retained.retained(index.scopeID, ownerRunID))
}

async function cancelLoop(
  loopPath: string[],
  loop: Record<string, unknown>,
  archiveSessionID: string,
): Promise<boolean> {
  if (!ACTIVE_LOOP_STATUSES.has(asString(loop.status) ?? "")) return false
  await Archive.preserve(loopPath[1], archiveSessionID, loopPath, loop)
  const now = Date.now()
  const time = asRecord(loop.time) ?? {}
  loop.status = "cancelled"
  loop.error = "Lattice v1 run was reset during the Lattice v2 migration."
  time.updated = now
  time.completed ??= now
  loop.time = time
  await Storage.write(loopPath, loop)
  return true
}

async function clearNoteBinding(
  scopeID: string,
  loopID: string,
  loop: Record<string, unknown>,
  archiveSessionID: string,
): Promise<boolean> {
  const noteID = asString(loop.noteID)
  if (!noteID) return false
  const scope = Identifier.asScopeID(scopeID)
  const notePath = StoragePath.note(scope, noteID)
  const note = asRecord(await readCandidate(notePath))
  const blueprint = asRecord(note?.blueprint)
  if (!note || blueprint?.activeLoopID !== loopID) return false
  await Archive.preserve(scopeID, archiveSessionID, notePath, note)
  const retained = NoteTypes.PersistedInfo.safeParse(note)
  if (retained.success) await NoteVersions.capture(scopeID, note)

  delete blueprint.activeLoopID
  note.blueprint = blueprint
  note.version =
    z
      .number()
      .int()
      .positive()
      .safe()
      .parse(note.version ?? 1) + 1
  note.time = { ...(asRecord(note.time) ?? {}), updated: Date.now() }
  await Storage.write(notePath, note)
  if (retained.success) await NoteVersions.capture(scopeID, note)
  await removeFileVerified(
    StoragePath.note(scope, "_index"),
    StoragePath.notesRoot(scope),
    "_index",
    "Failed to invalidate the Note index during the Lattice v2 migration.",
  )
  return true
}

async function clearSessionLoopBinding(
  scopeID: string,
  sessionID: string,
  loopID: string,
  archiveSessionID: string,
): Promise<boolean> {
  const scope = Identifier.asScopeID(scopeID)
  const sessionPath = StoragePath.sessionInfo(scope, Identifier.asSessionID(sessionID))
  const session = asRecord(await readCandidate(sessionPath))
  const blueprint = asRecord(session?.blueprint)
  if (!session || blueprint?.loopID !== loopID) return false
  await Archive.preserve(scopeID, archiveSessionID, sessionPath, session)

  delete blueprint.loopID
  delete blueprint.loopRole
  if (Object.keys(blueprint).length === 0) delete session.blueprint
  else session.blueprint = blueprint
  await Storage.write(sessionPath, session)
  return true
}

async function cleanSession(input: {
  scopeID: string
  sessionID: string
  runID: string | undefined
  runLoopIDs: Set<string>
  index: StrictV2Index
  includeUnboundLatticeLoop?: boolean
  persist?: boolean
}): Promise<{ changed: boolean; loopCandidate?: LoopCandidate }> {
  const scope = Identifier.asScopeID(input.scopeID)
  const sessionID = Identifier.asSessionID(input.sessionID)
  const sessionPath = StoragePath.sessionInfo(scope, sessionID)
  const session = asRecord(await readCandidate(sessionPath))
  if (!session) return { changed: false }

  let changed = false
  const workflow = asRecord(session.workflow)
  const legacy = asRecord(session.lattice)
  const workflowMatches =
    workflow?.kind === "lattice" &&
    !(await bindingReferencesStrictV2Run(workflow, input.scopeID, input.sessionID, input.index)) &&
    (await legacyBindingMatches(workflow, input.runID, input.index))
  const legacyMatches = await legacyBindingMatches(legacy, input.runID, input.index)

  if (workflowMatches) {
    delete session.workflow
    changed = true
  }
  if (legacy && legacyMatches) {
    delete session.lattice
    changed = true
  }

  const blueprint = asRecord(session.blueprint)
  const sessionLoopID = asString(blueprint?.loopID)
  const bindingOwnedByResetRun = workflowMatches || legacyMatches
  const candidateLoopID =
    sessionLoopID && (input.runLoopIDs.has(sessionLoopID) || bindingOwnedByResetRun || input.includeUnboundLatticeLoop)
      ? sessionLoopID
      : undefined
  let loopCandidate: LoopCandidate | undefined
  if (candidateLoopID) {
    const runIDs = new Set<string>()
    const workflowRunID = workflowMatches ? asString(workflow?.runID) : undefined
    const legacyRunID = legacyMatches ? asString(legacy?.runID) : undefined
    if (input.runID) runIDs.add(input.runID)
    if (workflowRunID) runIDs.add(workflowRunID)
    if (legacyRunID) runIDs.add(legacyRunID)
    loopCandidate = { loopID: candidateLoopID, runIDs }
  }

  if (changed && input.persist !== false) {
    const original = await Storage.read(sessionPath)
    await Archive.preserve(input.scopeID, input.sessionID, sessionPath, original)
    await Storage.write(sessionPath, session)
  }
  return { changed, loopCandidate }
}

async function cleanLegacyLoop(input: {
  scopeID: string
  sessionID: string
  candidate: LoopCandidate
  index: StrictV2Index
}): Promise<{ loopCancelled: boolean; sessionChanged: boolean; noteChanged: boolean }> {
  const scope = Identifier.asScopeID(input.scopeID)
  const loopPath = StoragePath.blueprintLoop(scope, input.candidate.loopID)
  const loop = asRecord(await readCandidate(loopPath))
  if (
    !loop ||
    !(await exactLatticeLoop(
      loop,
      input.candidate.loopID,
      input.scopeID,
      input.sessionID,
      input.candidate.runIDs,
      input.index,
    ))
  ) {
    return { loopCancelled: false, sessionChanged: false, noteChanged: false }
  }

  await Archive.preserve(input.scopeID, input.sessionID, loopPath, loop)

  const loopCancelled = await cancelLoop(loopPath, loop, input.sessionID)
  const noteChanged = await clearNoteBinding(input.scopeID, input.candidate.loopID, loop, input.sessionID)
  const sessionIDs = new Set<string>([input.sessionID])
  const executionSessionID = asString(loop.sessionID)
  const auditSessionID = asString(loop.auditSessionID)
  if (executionSessionID) sessionIDs.add(executionSessionID)
  if (auditSessionID) sessionIDs.add(auditSessionID)

  let sessionChanged = false
  for (const sessionID of sessionIDs) {
    if (await clearSessionLoopBinding(input.scopeID, sessionID, input.candidate.loopID, input.sessionID))
      sessionChanged = true
  }
  return { loopCancelled, sessionChanged, noteChanged }
}

async function resetLegacyRun(input: {
  scopeID: string
  recordKey: string
  raw: unknown | undefined
  index: StrictV2Index
}): Promise<{ loopCancelled: boolean; sessionChanged: boolean; noteChanged: boolean }> {
  const run = asRecord(input.raw)
  const runID = asString(run?.id)
  const sessionID = asString(run?.sessionID) ?? input.recordKey
  const scope = Identifier.asScopeID(input.scopeID)
  const runPath = StoragePath.latticeLegacyRun(scope, input.recordKey)
  if (input.raw === undefined)
    throw new Error("Cannot reset unreadable Lattice history without retaining its original bytes")
  await Archive.preserve(input.scopeID, sessionID, runPath, input.raw)
  const runLoopIDs = loopIDsFromRun(run)
  const sessionResult = await cleanSession({
    scopeID: input.scopeID,
    sessionID,
    runID,
    runLoopIDs,
    index: input.index,
  })
  const loopCandidates = new Map<string, LoopCandidate>()
  for (const loopID of runLoopIDs) addLoopCandidate(loopCandidates, loopID, runID)
  if (sessionResult.loopCandidate) {
    for (const candidateRunID of sessionResult.loopCandidate.runIDs) {
      addLoopCandidate(loopCandidates, sessionResult.loopCandidate.loopID, candidateRunID)
    }
    if (sessionResult.loopCandidate.runIDs.size === 0) {
      addLoopCandidate(loopCandidates, sessionResult.loopCandidate.loopID)
    }
  }

  let loopCancelled = false
  let sessionChanged = sessionResult.changed
  let noteChanged = false
  for (const candidate of loopCandidates.values()) {
    const result = await cleanLegacyLoop({ scopeID: input.scopeID, sessionID, candidate, index: input.index })
    if (result.loopCancelled) loopCancelled = true
    if (result.sessionChanged) sessionChanged = true
    if (result.noteChanged) noteChanged = true
  }

  for (const eventRoot of [
    StoragePath.latticeLegacyEventsRoot(scope, input.recordKey),
    ...(sessionID !== input.recordKey ? [StoragePath.latticeLegacyEventsRoot(scope, sessionID)] : []),
  ])
    for await (const row of Storage.records({ prefix: eventRoot, limit: 128 }))
      await Archive.preserve(input.scopeID, sessionID, row.key, row.value)
  await removeTreeVerified(StoragePath.latticeLegacyEventsRoot(scope, input.recordKey))
  if (sessionID !== input.recordKey) {
    await removeTreeVerified(StoragePath.latticeLegacyEventsRoot(scope, sessionID))
  }
  await removeFileVerified(
    StoragePath.latticeLegacyRun(scope, input.recordKey),
    StoragePath.latticeRunsRoot(scope),
    input.recordKey,
    "Failed to remove a legacy Lattice run record.",
  )

  return { loopCancelled, sessionChanged, noteChanged }
}

async function resetLatticeV1(progress: (current: number, total: number) => void): Promise<void> {
  await Retained.rebuild()
  let reset = 0
  let preserved = 0
  let current = 0
  for await (const row of Storage.records({ prefix: ["lattice", "runs"], limit: 128 })) {
    if (row.key.length !== 4) continue
    const scopeID = row.key[2]
    const schemaVersion = asRecord(row.value)?.schemaVersion
    if (strictV2Run(row.value) || (schemaVersion !== undefined && schemaVersion !== 1)) preserved++
    else {
      await Storage.transaction(() =>
        resetLegacyRun({ scopeID, recordKey: row.key[3], raw: row.value, index: { scopeID } }),
      )
      reset++
    }
    progress(++current, 0)
  }
  for await (const row of Storage.records({ prefix: ["sessions"], limit: 128 })) {
    if (row.key.length !== 4 || row.key[3] !== "info") continue
    const scopeID = row.key[1]
    const sessionID = row.key[2]
    const index = { scopeID }
    await Storage.transaction(async () => {
      const sessionInfo = asRecord(await readCandidate(row.key))
      const workflow = asRecord(sessionInfo?.workflow)
      const legacy = asRecord(sessionInfo?.lattice)
      const hadLegacyBinding =
        (await legacyBindingMatches(legacy, undefined, index)) ||
        (workflow?.kind === "lattice" && !(await bindingReferencesStrictV2Run(workflow, scopeID, sessionID, index)))
      if (hadLegacyBinding) {
        const events = StoragePath.latticeLegacyEventsRoot(Identifier.asScopeID(scopeID), sessionID)
        for await (const event of Storage.records({ prefix: events, limit: 128 }))
          await Archive.preserve(scopeID, sessionID, event.key, event.value)
        await removeTreeVerified(events)
      }
      const preview = await cleanSession({
        scopeID,
        sessionID,
        runID: undefined,
        runLoopIDs: new Set(),
        index,
        includeUnboundLatticeLoop: true,
        persist: false,
      })
      if (preview.loopCandidate) await cleanLegacyLoop({ scopeID, sessionID, candidate: preview.loopCandidate, index })
      await cleanSession({ scopeID, sessionID, runID: undefined, runLoopIDs: new Set(), index })
    })
    progress(++current, 0)
  }
  progress(current, current)
  log.info("Lattice v2 reset migration complete", { inspected: current, reset, preserved })
}

export const migrations: Migration[] = [
  {
    id: "20260722-lattice-v2-reset",
    description: "Reset incompatible Lattice v1 runs before enabling the recoverable Lattice v2 model",
    domain: "lattice",
    async up(progress) {
      await resetLatticeV1(progress)
    },
  },
  {
    id: "20261111-lattice-retained-legacy-archive-v1",
    description: "Retain available legacy Lattice records before reset and preserve unsupported schema data",
    domain: "lattice",
    scope: "global",
    execution: "maintenance",
    async up(progress) {
      await resetLatticeV1(progress)
    },
  },
]

export function registerLatticeMigrations() {
  MigrationRegistry.register("lattice", migrations)
}
