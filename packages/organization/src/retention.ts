import { z } from "zod"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import type { StoreTransaction } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { ActorStamp } from "@ericsanchezok/synergy-util/actor-stamp"
import {
  OrganizationIdentity as Identity,
  OrganizationProtocol as Protocol,
  OrganizationPublicationProtocol as Publication,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationServiceMaintenance as Admission } from "./service-maintenance"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { OrganizationSharedProjection } from "./shared-projection"
import { OrganizationSharedTasks } from "./shared-tasks"
import { fail } from "./error"
import { OrganizationPublications as Publications } from "./publications"

const Target = z.strictObject({
  sessionID: Identity.ID,
  shareGeneration: Identity.Revision.positive(),
  requestID: Identity.ID,
})
const Operator = ActorStamp.Info.refine(
  (value) => value.kind !== "account",
  "Retention requires trusted Host authority",
)
const Mark = Target.extend({
  actor: Operator,
  delayMs: z
    .number()
    .int()
    .positive()
    .safe()
    .default(24 * 60 * 60 * 1_000),
})
const Candidate = Target.extend({
  version: z.literal(1),
  orgID: Identity.ID,
  deploymentIncarnation: Identity.ID,
  actor: Operator,
  delayMs: z.number().int().positive().safe(),
  markedAt: z.number().int().nonnegative().safe(),
  notBefore: z.number().int().nonnegative().safe(),
  phase: z.enum(["marked", "collected"]),
  removedRecords: z.number().int().nonnegative().safe(),
  removedArtifacts: z.number().int().nonnegative().safe(),
}).refine((value) => value.notBefore === value.markedAt + value.delayMs, "Retention delay changed")
type Candidate = z.infer<typeof Candidate>
const UploadTarget = z.strictObject({ uploadID: Identity.ID, requestID: Identity.ID })
const UploadMark = UploadTarget.extend({ actor: Operator, delayMs: Mark.shape.delayMs })
const UploadCandidate = UploadTarget.extend({
  version: z.literal(1),
  orgID: Identity.ID,
  deploymentIncarnation: Identity.ID,
  abandonment: Publication.Abandonment,
  actor: Operator,
  delayMs: z.number().int().positive().safe(),
  markedAt: z.number().int().nonnegative().safe(),
  notBefore: z.number().int().nonnegative().safe(),
  phase: z.enum(["marked", "collected"]),
  removedArtifacts: z.number().int().nonnegative().safe(),
}).refine(
  (value) => value.notBefore === value.markedAt + value.delayMs && value.abandonment.uploadID === value.uploadID,
  "Publication retention evidence changed",
)
type UploadCandidate = z.infer<typeof UploadCandidate>
const uploadKey = (value: z.infer<typeof UploadTarget>) => [
  "organization-retention",
  "publication-uploads",
  value.requestID,
]
type Reason =
  | "missing_session"
  | "current_generation"
  | "handoff"
  | "unknown_state"
  | "incomplete_blob"
  | "deployment"
  | "missing_mark"
const key = (value: z.infer<typeof Target>) => ["organization-retention", "shared-generations", value.requestID]
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const Chunk = z.strictObject({
  offset: z.number().int().nonnegative().safe(),
  bytes: z
    .number()
    .int()
    .positive()
    .max(4 * 1024 * 1024),
})

function prefixes(value: z.infer<typeof Target>) {
  return [
    Keys.sharedBlobs(value.sessionID, value.shareGeneration),
    Keys.sharedEvents(value.sessionID, value.shareGeneration),
    Keys.sharedSessions(value.sessionID, value.shareGeneration),
    OrganizationSharedProjection.generationPrefix(value.sessionID, value.shareGeneration),
    OrganizationSharedTasks.generationPrefix(value.sessionID, value.shareGeneration),
  ]
}

async function eligible(value: z.infer<typeof Target>, candidate?: Candidate): Promise<Reason | undefined> {
  const deployment = await Record.read(Protocol.Deployment, Keys.deployment())
  if (!deployment) return "unknown_state"
  if (
    candidate &&
    (candidate.orgID !== deployment.orgID || candidate.deploymentIncarnation !== deployment.deploymentIncarnation)
  )
    return "deployment"
  const session = await Record.read(Record.SessionDirectory, Keys.session(value.sessionID))
  if (!session) return "missing_session"
  if (session.orgID !== deployment.orgID) return "deployment"
  if (session.shareGeneration <= value.shareGeneration) return "current_generation"
  if (session.handoffID) return "handoff"
  const state = await Record.read(Record.SharedState, Keys.sharedState(value.sessionID))
  if (
    !state ||
    state.sessionID !== session.sessionID ||
    state.shareGeneration !== session.shareGeneration ||
    state.bindingEpoch !== session.bindingEpoch
  )
    return "unknown_state"
}

async function inspect(value: z.infer<typeof Target>, tx: StoreTransaction) {
  let records = 0
  let artifacts = 0
  for (const [index, prefix] of prefixes(value).entries()) {
    for await (const row of Storage.records({ prefix, limit: 32 })) {
      if (index === 0) {
        if (row.key.length === prefix.length + 1) {
          const parsed = Record.SharedBlob.safeParse(row.value)
          if (
            !parsed.success ||
            parsed.data.sessionID !== value.sessionID ||
            parsed.data.shareGeneration !== value.shareGeneration ||
            parsed.data.hash !== row.key.at(-1)
          )
            return { reason: "unknown_state" as const }
          if (!parsed.data.complete) return { reason: "incomplete_blob" as const }
        } else if (row.key.length === prefix.length + 3 && row.key.at(-2) === "chunk-manifest") {
          const parsed = Chunk.safeParse(row.value)
          if (!parsed.success || row.key.at(-1) !== String(parsed.data.offset).padStart(16, "0"))
            return { reason: "unknown_state" as const }
        } else return { reason: "unknown_state" as const }
      } else if (index === 1) {
        const parsed = Record.SharedEvent.safeParse(row.value)
        if (!parsed.success || row.key.at(-1) !== String(parsed.data.event.sequence).padStart(16, "0"))
          return { reason: "unknown_state" as const }
      } else if (index === 2) {
        const parsed = Record.SharedSession.safeParse(row.value)
        if (
          !parsed.success ||
          parsed.data.rootSessionID !== value.sessionID ||
          parsed.data.projection.shareGeneration !== value.shareGeneration
        )
          return { reason: "unknown_state" as const }
      }
      records++
    }
    for await (const artifact of tx.artifacts(prefix)) {
      if (index !== 0 || artifact.key.length !== prefix.length + 3 || artifact.key.at(-2) !== "chunks")
        return { reason: "unknown_state" as const }
      const hash = artifact.key[prefix.length]!
      const manifest = await Record.read(
        Record.SharedBlob,
        Keys.sharedBlob(value.sessionID, value.shareGeneration, hash),
      )
      if (!manifest || !manifest.complete) return { reason: "incomplete_blob" as const }
      const offset = Number(artifact.key.at(-1))
      if (!Number.isSafeInteger(offset) || offset < 0 || String(offset).padStart(16, "0") !== artifact.key.at(-1))
        return { reason: "unknown_state" as const }
      artifacts++
    }
  }
  return { records, artifacts }
}

function original(candidate: Candidate, target: z.infer<typeof Target>) {
  if (
    candidate.requestID !== target.requestID ||
    candidate.sessionID !== target.sessionID ||
    candidate.shareGeneration !== target.shareGeneration
  )
    fail("REVISION_CONFLICT", "Retention requires its original mark request")
}

export namespace OrganizationRetention {
  export type MarkInput = z.input<typeof Mark>
  export type TargetInput = z.input<typeof Target>

  export namespace Uploads {
    export type TargetInput = z.input<typeof UploadTarget>
    export type MarkInput = z.input<typeof UploadMark>

    function original(candidate: UploadCandidate, target: TargetInput) {
      if (candidate.uploadID !== target.uploadID || candidate.requestID !== target.requestID)
        fail("REVISION_CONFLICT", "Publication retention requires its original mark request")
    }

    async function eligible(target: TargetInput, candidate?: UploadCandidate) {
      const deployment = await Record.read(Protocol.Deployment, Keys.deployment())
      if (!deployment) return { reason: "unknown_state" as const }
      if (
        candidate &&
        (candidate.orgID !== deployment.orgID || candidate.deploymentIncarnation !== deployment.deploymentIncarnation)
      )
        return { reason: "deployment" as const }
      const upload = await Publications.abandoned(target.uploadID)
      if (!upload) return { reason: "not_abandoned" as const }
      if (upload.orgID !== deployment.orgID) return { reason: "deployment" as const }
      if (candidate && !same(upload.abandonment, candidate.abandonment)) return { reason: "unknown_state" as const }
      return { deployment, abandonment: upload.abandonment! }
    }

    export async function status(input: TargetInput) {
      const value = UploadTarget.parse(input)
      const candidate = await Record.read(UploadCandidate, uploadKey(value))
      if (!candidate) return { state: "blocked" as const, reason: "missing_mark" as const }
      original(candidate, value)
      return { state: candidate.phase, candidate }
    }

    export async function mark(input: MarkInput) {
      const value = UploadMark.parse(input)
      return operation((assert) =>
        Storage.transaction(
          async () => {
            const current = await Record.read(UploadCandidate, uploadKey(value))
            if (current) {
              original(current, value)
              if (current.delayMs !== value.delayMs || !same(current.actor, value.actor))
                fail("REVISION_CONFLICT", "Publication retention mark input changed")
              return { state: current.phase, candidate: current }
            }
            const observed = await eligible(value)
            if ("reason" in observed) return { state: "blocked" as const, reason: observed.reason }
            if (!(await Publications.inspectAbandoned(value.uploadID)))
              return { state: "blocked" as const, reason: "unknown_state" as const }
            const markedAt = Date.now()
            const candidate = UploadCandidate.parse({
              ...value,
              version: 1,
              orgID: observed.deployment.orgID,
              deploymentIncarnation: observed.deployment.deploymentIncarnation,
              abandonment: observed.abandonment,
              markedAt,
              notBefore: markedAt + value.delayMs,
              phase: "marked",
              removedArtifacts: 0,
            })
            await Storage.write(uploadKey(value), candidate)
            return { state: candidate.phase, candidate }
          },
          { commitGuard: assert },
        ),
      )
    }

    export async function collect(input: TargetInput) {
      const value = UploadTarget.parse(input)
      return operation(async (assert) => {
        const observed = await Record.read(UploadCandidate, uploadKey(value))
        if (!observed) return { state: "blocked" as const, reason: "missing_mark" as const }
        original(observed, value)
        return Storage.transaction(
          async () => {
            const candidate = await Record.read(UploadCandidate, uploadKey(value))
            if (!candidate || !same(candidate, observed))
              fail("REVISION_CONFLICT", "Publication retention mark changed")
            if (candidate.phase === "collected") return { state: candidate.phase, candidate }
            if (Date.now() < candidate.notBefore) return { state: "waiting" as const, candidate }
            const current = await eligible(value, candidate)
            if ("reason" in current) return { state: "blocked" as const, reason: current.reason }
            const inspected = await Publications.inspectAbandoned(value.uploadID)
            if (!inspected) return { state: "blocked" as const, reason: "unknown_state" as const }
            await Storage.removeTree(Publications.bytesPrefix(value.uploadID))
            const collected = UploadCandidate.parse({
              ...candidate,
              phase: "collected",
              removedArtifacts: inspected.artifacts,
            })
            await Storage.write(uploadKey(value), collected)
            return { state: collected.phase, candidate: collected }
          },
          { commitGuard: assert },
        )
      })
    }
  }

  export async function status(input: TargetInput) {
    const value = Target.parse(input)
    const candidate = await Record.read(Candidate, key(value))
    if (!candidate) return { state: "blocked" as const, reason: "missing_mark" as const }
    original(candidate, value)
    return { state: candidate.phase, candidate }
  }

  export async function mark(input: MarkInput) {
    const value = Mark.parse(input)
    return operation(async (assert) =>
      Storage.transaction(
        async (tx) => {
          const current = await Record.read(Candidate, key(value))
          if (current) {
            original(current, value)
            if (current.delayMs !== value.delayMs || !same(current.actor, value.actor))
              fail("REVISION_CONFLICT", "Retention mark input changed")
            return { state: current.phase, candidate: current }
          }
          const reason = await eligible(value)
          if (reason) return { state: "blocked" as const, reason }
          const inspected = await inspect(value, tx)
          if ("reason" in inspected) return { state: "blocked" as const, reason: inspected.reason }
          const deployment = (await Record.read(Protocol.Deployment, Keys.deployment()))!
          const markedAt = Date.now()
          const candidate = Candidate.parse({
            ...value,
            version: 1,
            orgID: deployment.orgID,
            deploymentIncarnation: deployment.deploymentIncarnation,
            markedAt,
            notBefore: markedAt + value.delayMs,
            phase: "marked",
            removedRecords: 0,
            removedArtifacts: 0,
          })
          await Storage.write(key(value), candidate)
          return { state: candidate.phase, candidate }
        },
        { commitGuard: assert },
      ),
    )
  }

  export async function collect(input: TargetInput) {
    const value = Target.parse(input)
    return operation(async (assert) => {
      const observed = await Record.read(Candidate, key(value))
      if (!observed) return { state: "blocked" as const, reason: "missing_mark" as const }
      original(observed, value)
      return Storage.transaction(
        async (tx) => {
          const candidate = await Record.read(Candidate, key(value))
          if (!candidate || !same(candidate, observed)) fail("REVISION_CONFLICT", "Retention mark changed")
          if (candidate.phase === "collected") return { state: candidate.phase, candidate }
          if (Date.now() < candidate.notBefore) return { state: "waiting" as const, candidate }
          const reason = await eligible(value, candidate)
          if (reason) return { state: "blocked" as const, reason }
          const inspected = await inspect(value, tx)
          if ("reason" in inspected) return { state: "blocked" as const, reason: inspected.reason }
          for (const prefix of prefixes(value)) await Storage.removeTree(prefix)
          const collected = Candidate.parse({
            ...candidate,
            phase: "collected",
            removedRecords: inspected.records,
            removedArtifacts: inspected.artifacts,
          })
          await Storage.write(key(value), collected)
          return { state: collected.phase, candidate: collected }
        },
        { commitGuard: assert },
      )
    })
  }

  async function operation<T>(body: (assert: () => void) => Promise<T>) {
    if (Storage.inTransaction()) fail("INVALID_REQUEST", "Retention must own its operation and transaction")
    const runtime = RuntimeContext.current()
    const primary = runtime.storage
    const store = Storage.current().store
    let open = true
    const assert = () => {
      if (
        !open ||
        RuntimeContext.current() !== runtime ||
        runtime.storage !== primary ||
        Storage.current().store !== store
      )
        fail("PERMISSION_DENIED", "Retention requires its original service operation")
    }
    try {
      return await Admission.run(() => body(assert))
    } finally {
      open = false
    }
  }
}
