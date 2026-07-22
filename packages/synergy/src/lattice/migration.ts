import { Identifier } from "../id/id"
import type { Migration } from "../migration"
import { MigrationRegistry } from "../migration/registry"
import { StoragePath } from "../storage/path"
import { Storage } from "../storage/storage"
import { Log } from "../util/log"
import { LatticeTypes } from "./types"

const log = Log.create({ service: "lattice.migration" })

const ACTIVE_LOOP_STATUSES = new Set(["armed", "running", "waiting", "auditing"])

type StrictV2Index = {
  runsByID: Map<string, LatticeTypes.Run>
  loopOwners: Map<string, Set<string>>
  pendingCreates: Array<{
    runID: string
    sessionID: string
    noteID: string
    sourceDigest: string
  }>
}

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

function emptyStrictV2Index(): StrictV2Index {
  return { runsByID: new Map(), loopOwners: new Map(), pendingCreates: [] }
}

function addLoopOwner(index: StrictV2Index, loopID: string, runID: string): void {
  const owners = index.loopOwners.get(loopID) ?? new Set<string>()
  owners.add(runID)
  index.loopOwners.set(loopID, owners)
}

function indexStrictV2Run(index: StrictV2Index, run: LatticeTypes.Run): void {
  index.runsByID.set(run.id, run)
  for (const step of run.pathway) {
    for (const attempt of step.loopHistory) addLoopOwner(index, attempt.loopID, run.id)
  }
  if (run.effect?.kind === "start_blueprint_loop") addLoopOwner(index, run.effect.loopID, run.id)
  if (run.effect?.kind === "create_blueprint_loop") {
    index.pendingCreates.push({
      runID: run.id,
      sessionID: run.sessionID,
      noteID: run.effect.blueprintNoteID,
      sourceDigest: run.effect.sourceDigest,
    })
  }
}

function addLoopCandidate(candidates: Map<string, LoopCandidate>, loopID: string, runID?: string): void {
  const candidate = candidates.get(loopID) ?? { loopID, runIDs: new Set<string>() }
  if (runID) candidate.runIDs.add(runID)
  candidates.set(loopID, candidate)
}

function ownedByStrictV2(loopID: string, loop: Record<string, unknown>, index: StrictV2Index): boolean {
  if (index.loopOwners.has(loopID)) return true

  const orchestration = asRecord(loop.orchestration)
  const orchestrationRunID = orchestration?.kind === "lattice" ? asString(orchestration.runID) : undefined
  if (orchestrationRunID && index.runsByID.has(orchestrationRunID)) return true
  if (loop.source !== "lattice") return false

  const sessionID = asString(loop.sessionID)
  const noteID = asString(loop.noteID)
  const sourceDigest = asString(loop.sourceDigest)
  if (!sessionID || !noteID || !sourceDigest) return false
  return index.pendingCreates.some(
    (effect) => effect.sessionID === sessionID && effect.noteID === noteID && effect.sourceDigest === sourceDigest,
  )
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
  if ((await Storage.scan(parent)).includes(leaf)) throw new Error(message)
}

async function removeTreeVerified(root: string[]): Promise<void> {
  await Storage.removeTree(root)
  if ((await Storage.scan(root)).length > 0) throw new Error("Failed to remove legacy Lattice event records.")
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

function bindingReferencesStrictV2Run(
  binding: Record<string, unknown> | undefined,
  scopeID: string,
  sessionID: string,
  index: StrictV2Index,
): boolean {
  if (!binding) return false
  const boundRunID = asString(binding.runID)
  if (!boundRunID) return false
  const run = index.runsByID.get(boundRunID)
  return !!run && run.scopeID === scopeID && run.sessionID === sessionID
}

function legacyBindingMatches(
  binding: Record<string, unknown> | undefined,
  runID: string | undefined,
  index: StrictV2Index,
): boolean {
  if (!binding) return false
  const boundRunID = asString(binding.runID)
  if (boundRunID && index.runsByID.has(boundRunID)) return false
  return runID ? boundRunID === runID : true
}

function exactLatticeLoop(
  loop: Record<string, unknown> | undefined,
  loopID: string,
  scopeID: string,
  sessionID: string,
  expectedRunIDs: Set<string>,
  index: StrictV2Index,
): loop is Record<string, unknown> {
  const ownsExecutionSession = loop?.sessionID === sessionID
  const ownsAuditSession = loop?.auditSessionID === sessionID
  if (loop?.id !== loopID || loop.scopeID !== scopeID || (!ownsExecutionSession && !ownsAuditSession)) return false
  if (ownedByStrictV2(loopID, loop, index)) return false

  const source = asString(loop.source)
  const orchestration = asRecord(loop.orchestration)
  if (source && source !== "lattice") return false
  if (orchestration && orchestration.kind !== "lattice") return false
  if (!source && orchestration?.kind !== "lattice") return false

  const ownerRunID = orchestration?.kind === "lattice" ? asString(orchestration.runID) : undefined
  if (ownerRunID && !ownsAuditSession && (expectedRunIDs.size === 0 || !expectedRunIDs.has(ownerRunID))) return false
  return !ownerRunID || !index.runsByID.has(ownerRunID)
}

async function cancelLoop(loopPath: string[], loop: Record<string, unknown>): Promise<boolean> {
  if (!ACTIVE_LOOP_STATUSES.has(asString(loop.status) ?? "")) return false
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

async function clearNoteBinding(scopeID: string, loopID: string, loop: Record<string, unknown>): Promise<boolean> {
  const noteID = asString(loop.noteID)
  if (!noteID) return false
  const scope = Identifier.asScopeID(scopeID)
  const notePath = StoragePath.note(scope, noteID)
  const note = asRecord(await readCandidate(notePath))
  const blueprint = asRecord(note?.blueprint)
  if (!note || blueprint?.activeLoopID !== loopID) return false

  delete blueprint.activeLoopID
  note.blueprint = blueprint
  await Storage.write(notePath, note)
  await removeFileVerified(
    StoragePath.note(scope, "_index"),
    StoragePath.notesRoot(scope),
    "_index",
    "Failed to invalidate the Note index during the Lattice v2 migration.",
  )
  return true
}

async function clearSessionLoopBinding(scopeID: string, sessionID: string, loopID: string): Promise<boolean> {
  const scope = Identifier.asScopeID(scopeID)
  const sessionPath = StoragePath.sessionInfo(scope, Identifier.asSessionID(sessionID))
  const session = asRecord(await readCandidate(sessionPath))
  const blueprint = asRecord(session?.blueprint)
  if (!session || blueprint?.loopID !== loopID) return false

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
    !bindingReferencesStrictV2Run(workflow, input.scopeID, input.sessionID, input.index) &&
    legacyBindingMatches(workflow, input.runID, input.index)
  const legacyMatches = legacyBindingMatches(legacy, input.runID, input.index)

  if (workflowMatches) {
    delete session.workflow
    changed = true
  }
  if (legacy) {
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

  if (changed && input.persist !== false) await Storage.write(sessionPath, session)
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
    !exactLatticeLoop(loop, input.candidate.loopID, input.scopeID, input.sessionID, input.candidate.runIDs, input.index)
  ) {
    return { loopCancelled: false, sessionChanged: false, noteChanged: false }
  }

  const loopCancelled = await cancelLoop(loopPath, loop)
  const noteChanged = await clearNoteBinding(input.scopeID, input.candidate.loopID, loop)
  const sessionIDs = new Set<string>([input.sessionID])
  const executionSessionID = asString(loop.sessionID)
  const auditSessionID = asString(loop.auditSessionID)
  if (executionSessionID) sessionIDs.add(executionSessionID)
  if (auditSessionID) sessionIDs.add(auditSessionID)

  let sessionChanged = false
  for (const sessionID of sessionIDs) {
    if (await clearSessionLoopBinding(input.scopeID, sessionID, input.candidate.loopID)) sessionChanged = true
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

  const scope = Identifier.asScopeID(input.scopeID)
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
  const scopeIDs = await Storage.scan(StoragePath.latticeRunsRoot())
  const records: Array<{ scopeID: string; recordKey: string; raw: unknown | undefined }> = []
  const indexes = new Map<string, StrictV2Index>()
  for (const scopeID of scopeIDs) {
    const recordKeys = await Storage.scan(StoragePath.latticeRunsRoot(Identifier.asScopeID(scopeID)))
    const index = emptyStrictV2Index()
    indexes.set(scopeID, index)
    for (const recordKey of recordKeys) {
      const raw = await readCandidate(StoragePath.latticeRun(Identifier.asScopeID(scopeID), recordKey))
      records.push({ scopeID, recordKey, raw })
      const run = strictV2Run(raw)
      if (run) indexStrictV2Run(index, run)
    }
  }

  const sessionScopeIDs = await Storage.scan(["sessions"])
  const sessions: Array<{ scopeID: string; sessionID: string }> = []
  for (const scopeID of sessionScopeIDs) {
    const sessionIDs = await Storage.scan(StoragePath.sessionsRoot(Identifier.asScopeID(scopeID)))
    for (const sessionID of sessionIDs) sessions.push({ scopeID, sessionID })
    if (!indexes.has(scopeID)) indexes.set(scopeID, emptyStrictV2Index())
  }

  let reset = 0
  let preserved = 0
  let loopsCancelled = 0
  let sessionsChanged = 0
  let notesChanged = 0
  let current = 0
  const total = records.length + sessions.length

  for (const record of records) {
    if (strictV2Run(record.raw)) {
      preserved++
    } else {
      const result = await resetLegacyRun({
        ...record,
        index: indexes.get(record.scopeID) ?? emptyStrictV2Index(),
      })
      reset++
      if (result.loopCancelled) loopsCancelled++
      if (result.sessionChanged) sessionsChanged++
      if (result.noteChanged) notesChanged++
    }
    current++
    progress(current, total)
  }

  for (const session of sessions) {
    const index = indexes.get(session.scopeID) ?? emptyStrictV2Index()
    const sessionInfo = asRecord(
      await readCandidate(
        StoragePath.sessionInfo(Identifier.asScopeID(session.scopeID), Identifier.asSessionID(session.sessionID)),
      ),
    )
    const workflow = asRecord(sessionInfo?.workflow)
    const hadLegacyBinding =
      !!asRecord(sessionInfo?.lattice) ||
      (workflow?.kind === "lattice" &&
        !bindingReferencesStrictV2Run(workflow, session.scopeID, session.sessionID, index))
    if (hadLegacyBinding) {
      await removeTreeVerified(
        StoragePath.latticeLegacyEventsRoot(Identifier.asScopeID(session.scopeID), session.sessionID),
      )
    }
    const preview = await cleanSession({
      scopeID: session.scopeID,
      sessionID: session.sessionID,
      runID: undefined,
      runLoopIDs: new Set(),
      index,
      includeUnboundLatticeLoop: true,
      persist: false,
    })
    let loopSessionChanged = false
    if (preview.loopCandidate) {
      const loopResult = await cleanLegacyLoop({
        scopeID: session.scopeID,
        sessionID: session.sessionID,
        candidate: preview.loopCandidate,
        index,
      })
      if (loopResult.loopCancelled) loopsCancelled++
      if (loopResult.noteChanged) notesChanged++
      loopSessionChanged = loopResult.sessionChanged
    }
    const result = await cleanSession({
      scopeID: session.scopeID,
      sessionID: session.sessionID,
      runID: undefined,
      runLoopIDs: new Set(),
      index,
    })
    if (loopSessionChanged && !result.changed) sessionsChanged++
    if (result.changed) sessionsChanged++
    current++
    progress(current, total)
  }

  log.info("Lattice v2 reset migration complete", {
    inspected: total,
    reset,
    preserved,
    loopsCancelled,
    sessionsChanged,
    notesChanged,
  })
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
]

MigrationRegistry.register("lattice", migrations)
