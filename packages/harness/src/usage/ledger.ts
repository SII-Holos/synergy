import { createHash } from "node:crypto"
import { z } from "zod"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { RolloutSchema } from "../session/rollout/schema"
import { RolloutUsage } from "../session/rollout/usage"
import { UsageSchema } from "./schema"
import { BusEvent } from "../bus/bus-event"
import { Bus } from "../bus"
import { ScopeContext } from "../scope/context"
import { Identifier } from "../id/id"
import { Scope } from "../scope"
import { RolloutArtifact } from "../session/rollout/artifact"
import { RolloutUsageCapture } from "../session/rollout/usage-capture"
import { ProviderPricing } from "../provider/pricing"
import { Lock } from "../util/lock"
import type { StoreTransaction } from "../storage/transactional-store"

export namespace UsageLedger {
  export const Updated = BusEvent.define(
    "usage.updated",
    z
      .object({
        revision: z.number(),
        owner: RolloutSchema.Owner,
        runID: z.string(),
        recordID: z.string(),
        kind: z.enum(["run", "call", "attempt", "tool", "legacy", "gap"]),
        status: RolloutSchema.Status,
        phase: z.enum(["queued", "request", "generating", "tool", "terminal"]),
        record: UsageSchema.Record,
      })
      .strict(),
  )
  const State = z.object({ version: z.literal(1), revision: z.number().int().nonnegative() }).strict()
  export function ownerKey(owner: UsageSchema.Owner) {
    return owner.kind === "session" ? `session_${owner.sessionID}` : `operation_${owner.operationID}`
  }
  export function key(value: Pick<UsageSchema.Record, "owner" | "runID" | "kind" | "entityID">) {
    return StoragePath.usageRecord(value.owner.scopeID, ownerKey(value.owner), value.runID, value.kind, value.entityID)
  }
  function identity(value: Pick<UsageSchema.Record, "owner" | "runID" | "kind" | "entityID">) {
    return createHash("sha256")
      .update(JSON.stringify(key(value)))
      .digest("hex")
  }
  export function timeKey(value: UsageSchema.Record) {
    const time = value.kind === "attempt" ? (value.timing?.sentAt ?? value.started) : value.started
    return StoragePath.usageTime(
      value.owner.scopeID,
      ownerKey(value.owner),
      `${String(time).padStart(17, "0")}_${value.id}`,
    )
  }
  export async function index(value: UsageSchema.Record) {
    const path = timeKey(value)
    if (await optional(path)) return false
    await Storage.write(path, { key: key(value) })
    return true
  }
  export async function repairIndex(value: UsageSchema.Record) {
    await Storage.transaction(async () => {
      if (!(await index(value))) return
      await Storage.write(StoragePath.usageState(), { version: 1, revision: (await revision()) + 1 })
    })
  }
  export async function link(
    owner: UsageSchema.Owner,
    runID: string,
    parent?: z.infer<typeof UsageSchema.Run>["parent"],
  ) {
    const session =
      owner.kind === "session"
        ? await optional<{ parentID?: string }>(
            StoragePath.sessionInfo(Identifier.asScopeID(owner.scopeID), Identifier.asSessionID(owner.sessionID)),
          )
        : undefined
    const path = StoragePath.usageLink(owner.scopeID, ownerKey(owner), runID)
    const previous = await optional<UsageSchema.Link>(path)
    const value = UsageSchema.Link.parse({
      owner,
      runID,
      parent: parent ?? previous?.parent,
      parentOwner: session?.parentID
        ? { kind: "session", scopeID: owner.scopeID, sessionID: session.parentID }
        : previous?.parentOwner,
    })
    if (JSON.stringify(previous) !== JSON.stringify(value)) await Storage.write(path, value)
    return value
  }
  async function optional<T>(key: string[]): Promise<T | undefined> {
    return Storage.read<T>(key, { silentNotFound: true }).catch((error) => {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    })
  }
  export async function revision() {
    const value = await optional(StoragePath.usageState())
    return value ? State.parse(value).revision : 0
  }
  export async function committed(owner: UsageSchema.Owner, revision: number) {
    const key = StoragePath.usageOwnerCheckpoint(owner.scopeID, ownerKey(owner))
    const previous = await optional<{ revision: number }>(key)
    if ((previous?.revision ?? 0) === revision - 1) await Storage.write(key, { revision })
  }
  const meters = new Set([
    "tokens",
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "prompt_tokens",
    "completion_tokens",
    "cached_tokens",
    "reasoning_tokens",
    "cache_write_tokens",
    "prompt_cache_hit_tokens",
    "prompt_cache_miss_tokens",
    "input_tokens_details",
    "output_tokens_details",
    "prompt_tokens_details",
    "completion_tokens_details",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "cache_creation",
    "ephemeral_5m_input_tokens",
    "ephemeral_1h_input_tokens",
    "promptTokenCount",
    "candidatesTokenCount",
    "thoughtsTokenCount",
    "cachedContentTokenCount",
    "totalTokenCount",
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "reasoningTokens",
    "cachedInputTokens",
    "audio_tokens",
    "input_token_details",
    "seconds",
    "cost",
  ])
  export function compactUsage(value: RolloutUsage.Info | undefined): RolloutUsage.Info | undefined {
    if (!value) return undefined
    function numeric(raw: unknown, depth = 0): z.infer<ReturnType<typeof z.json>> {
      if (depth > 3 || !raw || typeof raw !== "object" || Array.isArray(raw)) return null
      return Object.fromEntries(
        Object.entries(raw).flatMap(([name, value]) => {
          if (!meters.has(name)) return []
          if (typeof value === "number" && Number.isFinite(value) && value >= 0) return [[name, value]]
          if (value && typeof value === "object") return [[name, numeric(value, depth + 1)]]
          return []
        }),
      )
    }
    return { ...value, raw: numeric(value.raw) }
  }
  function model(value: z.infer<typeof RolloutSchema.Model>) {
    return { ...value, ...(value.pricing ? { pricing: { ...value.pricing, raw: null } } : {}) }
  }
  export function phase(value: UsageSchema.Record) {
    if (value.status !== "running") return "terminal" as const
    if (value.kind === "tool") return "tool" as const
    if (value.kind === "attempt")
      return value.timing?.firstContentAt !== undefined
        ? ("generating" as const)
        : value.timing?.sentAt !== undefined
          ? ("request" as const)
          : ("queued" as const)
    return "queued" as const
  }
  function content(value: UsageSchema.Record) {
    const { revision, sourceRevision, ...rest } = value
    return JSON.stringify(rest)
  }
  const published = Storage.state(() => new Map<string, number>())
  async function put(input: UsageSchema.Record, notify = true) {
    if (!Storage.inTransaction()) throw new Error("Usage facts require the source transaction")
    if (await optional(StoragePath.usageSuppressed(input.id))) return
    if (
      input.kind === "attempt" &&
      (await optional(StoragePath.usageSuppressed(identity({ ...input, kind: "call", entityID: input.callID }))))
    )
      return
    const previous = await optional<UsageSchema.Record>(key(input))
    if (previous?.kind === "call" && input.kind === "call")
      input = { ...input, hasAttempts: input.hasAttempts || previous.hasAttempts }
    if (previous && (previous.sourceRevision > input.sourceRevision || content(previous) === content(input))) return
    const now = Date.now()
    if (
      notify &&
      previous &&
      input.kind === "attempt" &&
      input.status === "running" &&
      phase(previous) === phase(input) &&
      now - (published().get(input.id) ?? 0) < 1000
    )
      return
    const next = UsageSchema.Record.parse({ ...input, revision: (await revision()) + 1 })
    if (previous?.kind === "call" && next.kind === "call") next.hasAttempts ||= previous.hasAttempts
    await Storage.write(key(next), next)
    if (previous && timeKey(previous).join("/") !== timeKey(next).join("/")) await Storage.remove(timeKey(previous))
    await index(next)
    await Storage.write(StoragePath.usageState(), { version: 1, revision: next.revision })
    Storage.afterCommit(() => {
      if (next.status === "running") published().set(next.id, now)
      else published().delete(next.id)
    })
    if (notify)
      await ScopeContext.provide({
        scope: ScopeContext.tryScope() ?? Scope.home(),
        fn: () =>
          Bus.publish(Updated, {
            revision: next.revision,
            owner: next.owner,
            runID: next.runID,
            recordID: next.id,
            kind: next.kind,
            status: next.status,
            phase: phase(next),
            record: next,
          }),
      })
    return next
  }
  export async function capture(
    owner: UsageSchema.Owner,
    sourceRevision: number,
    path: string[],
    raw: unknown,
    notify = true,
  ) {
    if (path[0] !== "runs") return
    const kind =
      path.length === 3 && path[2] === "info"
        ? "run"
        : path.length === 4 && path[2] === "calls"
          ? "call"
          : path.length === 5 && path[2] === "attempts"
            ? "attempt"
            : path.length === 4 && path[2] === "tools"
              ? "tool"
              : undefined
    if (!kind) return
    const schemas = {
      run: RolloutSchema.RunRecord,
      call: RolloutSchema.CallRecord,
      attempt: RolloutSchema.AttemptRecord,
      tool: RolloutSchema.ToolExecutionRecord,
    }
    const source = schemas[kind].parse(raw)
    const runID = "runID" in source ? source.runID : source.id
    if (
      runID !== path[1] ||
      (kind !== "run" && path.at(-1) !== source.id) ||
      JSON.stringify(source.owner) !== JSON.stringify(RolloutSchema.Owner.parse(owner))
    )
      throw new Error("Usage source identity mismatch")
    const entityID = source.id
    const id = identity({ owner, runID, entityID, kind })
    const common = {
      version: 1 as const,
      id,
      entityID,
      owner,
      runID,
      revision: 0,
      sourceRevision,
      started: source.started,
      ended: source.status === "interrupted" ? undefined : source.ended,
      status: source.status,
      source: "source" in source && source.source ? ("imported" as const) : ("local" as const),
    }
    if (kind === "run") {
      const value = RolloutSchema.RunRecord.parse(raw)
      const relationship = await link(owner, runID, value.parent)
      return put(
        {
          ...common,
          kind,
          parent: relationship.parent,
          parentOwner: relationship.parentOwner,
        },
        notify,
      )
    }
    if (kind === "tool") {
      const value = RolloutSchema.ToolExecutionRecord.parse(raw)
      const run = await optional<z.infer<typeof UsageSchema.Run>>(key({ owner, runID, kind: "run", entityID: runID }))
      return put(
        {
          ...common,
          kind,
          source: run?.source ?? common.source,
          tool: value.tool,
          durationMs: common.ended === undefined || common.ended < value.started ? null : common.ended - value.started,
        },
        notify,
      )
    }
    const call =
      kind === "call"
        ? RolloutSchema.CallRecord.parse(raw)
        : await readCall(owner, runID, RolloutSchema.AttemptRecord.parse(raw).callID)
    if (!call) throw new Error("Usage attempt is missing its call")
    const attribution = {
      purpose: call.purpose,
      usageRole: call.usageRole,
      agent: call.agent,
      model: model(call.model),
      execution: call.execution ?? ("provider" as const),
      callKind: call.kind ?? ("chat" as const),
      retryIndex: call.retryIndex,
      source: call.source ? ("imported" as const) : common.source,
    }
    if (kind === "call")
      return put(
        {
          ...common,
          ...attribution,
          kind,
          parentCallID: call.parentCallID,
          hasAttempts: call.transportCaptured,
          usage: compactUsage(RolloutUsage.normalizeSdk(call.sdkUsage, call.model.sdk, call.kind) ?? undefined),
          estimate: call.sdkEstimate,
        },
        notify,
      )
    const value = RolloutSchema.AttemptRecord.parse(raw)
    const parentKey = key({ owner, runID, kind: "call", entityID: value.callID })
    const parent = await optional<z.infer<typeof UsageSchema.Call>>(parentKey)
    if (parent && !parent.hasAttempts) await put({ ...parent, sourceRevision, hasAttempts: true }, false)
    return put(
      {
        ...common,
        ...attribution,
        kind,
        callID: value.callID,
        index: value.index,
        usage: compactUsage(value.usage),
        estimate: value.estimate,
        timing: value.timing,
        usageFinal: value.usageFinal ?? value.status === "completed",
        pricingEvidence: value.pricingEvidence,
        httpStatus: value.httpStatus,
        responseModel: value.responseModel,
      },
      notify,
    )
  }
  async function readCall(owner: UsageSchema.Owner, runID: string, callID: string) {
    const root =
      owner.kind === "session"
        ? StoragePath.sessionRolloutRoot(Identifier.asScopeID(owner.scopeID), Identifier.asSessionID(owner.sessionID))
        : StoragePath.operationRolloutRoot(Identifier.asScopeID(owner.scopeID), owner.operationID)
    const value = await optional([...root, "runs", runID, "calls", callID])
    return value ? RolloutSchema.CallRecord.parse(value) : undefined
  }
  export async function captureBatch(owner: UsageSchema.Owner, limit = 128) {
    using lock = await Lock.write(`usage-capture:${owner.scopeID}:${ownerKey(owner)}`)
    const { RolloutJournal } = await import("../session/rollout/journal")
    const head = await RolloutJournal.head(owner)
    const checkpointKey = StoragePath.usageOwnerCheckpoint(owner.scopeID, ownerKey(owner))
    const checkpoint = await optional<{ revision: number }>(checkpointKey)
    const after = checkpoint?.revision ?? 0
    if (after >= head.committed) return { processed: 0, complete: true }
    const through = Math.min(head.committed, after + limit)
    const events: (typeof RolloutJournal.Event._output)[] = []
    for await (const event of RolloutJournal.events(owner, through, after)) {
      if (event.kind === "record" && event.key[2] === "attempts") {
        const attempt = RolloutSchema.AttemptRecord.parse(event.value)
        if (
          attempt.status !== "running" &&
          (!attempt.usage ||
            (attempt.usage.input.total === null &&
              attempt.usage.output.total === null &&
              !attempt.usage.reported &&
              !attempt.usage.units.length)) &&
          attempt.response
        ) {
          const call = await readCall(owner, attempt.runID, attempt.callID)
          if (!call) throw new Error("Historical usage attempt is missing its call")
          const capture = RolloutUsageCapture.create(
            call.model.sdk,
            attempt.response.mediaType,
            call.model.providerID,
            call.kind,
          )
          try {
            for await (const bytes of RolloutArtifact.read(owner, attempt.response)) capture.append(bytes)
          } catch (error) {
            if (!(error instanceof Storage.NotFoundError)) throw error
            events.push(event)
            continue
          }
          const usage = capture.finish()
          if (capture.hasUsage()) {
            attempt.usage = usage
            attempt.usageFinal =
              capture.hasFinalUsage() || (attempt.status === "completed" && attempt.response.status === "complete")
            attempt.estimate ??= ProviderPricing.estimate(
              attempt.pricingEvidence ? attempt.pricingEvidence.pricing : call.model.pricing,
              usage,
              call.model.billingMode ?? "unknown",
              attempt.ended,
            )
            event.value = JSON.parse(JSON.stringify(attempt))
          }
        }
      }
      events.push(event)
    }
    await Storage.transaction(async () => {
      for (const event of events) {
        if (event.kind === "record") await capture(owner, event.seq, event.key, event.value, false)
        else await captureGap(owner, event.seq, event.time)
      }
      const current = await optional<{ revision: number }>(checkpointKey)
      await Storage.write(checkpointKey, { revision: Math.max(through, current?.revision ?? 0) })
    })
    return { processed: events.length, complete: through === head.committed }
  }
  export async function captureOwner(owner: UsageSchema.Owner) {
    let processed = 0
    for (;;) {
      const batch = await captureBatch(owner)
      processed += batch.processed
      if (batch.complete) return processed
    }
  }
  export async function hasClearedCall(owner: UsageSchema.Owner, runID: string, callIDs: string[]) {
    const markers = await Storage.readMany(
      callIDs.map((entityID) => StoragePath.usageSuppressed(identity({ owner, runID, kind: "call", entityID }))),
    )
    return markers.some(Boolean)
  }
  export async function captureGap(owner: UsageSchema.Owner, seq: number, time: number) {
    const record = { owner, runID: "unattributed", kind: "gap" as const, entityID: String(seq) }
    return put(
      {
        ...record,
        version: 1,
        id: identity(record),
        revision: 0,
        sourceRevision: seq,
        started: time,
        status: "interrupted",
        source: "legacy",
        sequence: seq,
      },
      false,
    )
  }
  export async function writeLegacy(
    input: Omit<
      z.infer<typeof UsageSchema.Legacy>,
      "version" | "id" | "revision" | "sourceRevision" | "source" | "kind"
    >,
  ) {
    const record = { ...input, kind: "legacy" as const }
    await link(input.owner, input.runID)
    await put({ ...record, version: 1, id: identity(record), revision: 0, sourceRevision: 0, source: "legacy" }, false)
  }
  export async function writeLegacyTool(
    input: Omit<z.infer<typeof UsageSchema.Tool>, "version" | "id" | "revision" | "sourceRevision" | "source" | "kind">,
  ) {
    const record = { ...input, kind: "tool" as const }
    await put({ ...record, version: 1, id: identity(record), revision: 0, sourceRevision: 0, source: "legacy" }, false)
  }
  export async function clear(filter: UsageSchema.Filter, through: number) {
    if (!filter.scopeID && !filter.sessionID && filter.from === undefined && filter.to === undefined)
      throw new UsageSchema.InvalidQuery({
        message: "Usage deletion requires an explicit Scope, session or time range",
      })
    if (!Number.isSafeInteger(through) || through < 0 || through > (await revision()))
      throw new UsageSchema.InvalidQuery({ message: "Invalid usage deletion revision" })
    const { UsageQuery } = await import("./query")
    let removed = 0,
      activeRetained = 0,
      newerRetained = 0,
      unattributedRetained = 0
    for await (const record of UsageQuery.scan(filter))
      await Storage.transaction(async () => {
        const current = await optional<UsageSchema.Record>(key(record))
        if (!current) return
        if (current.status === "running") {
          activeRetained++
          return
        }
        if (current.revision > through) {
          newerRetained++
          return
        }
        if (filter.runID && current.kind === "gap") {
          unattributedRetained++
          return
        }
        await Storage.write(StoragePath.usageSuppressed(current.id), { version: 1, through, clearedAt: Date.now() })
        await Storage.remove(key(current))
        await Storage.remove(timeKey(current))
        await Storage.write(StoragePath.usageState(), { version: 1, revision: (await revision()) + 1 })
        removed++
      })
    return { removed, activeRetained, newerRetained, unattributedRetained, revision: await revision() }
  }
  export async function reconcileTransfer(tx: StoreTransaction) {
    const [state] = await tx.readMany<{ revision: number }>([StoragePath.usageState()])
    let revision = state?.revision ?? 0
    let after: string[] | undefined
    for (;;) {
      const page = await tx.query<UsageSchema.Record>({ kind: "usage", after, limit: 128 })
      if (!page.length) break
      for (const row of page) {
        const record = UsageSchema.Record.parse(row.value)
        revision = Math.max(revision, record.revision)
        const suppressed = await tx.readMany([
          StoragePath.usageSuppressed(record.id),
          ...(record.kind === "attempt"
            ? [StoragePath.usageSuppressed(identity({ ...record, kind: "call", entityID: record.callID }))]
            : []),
        ])
        if (suppressed.some(Boolean)) {
          await tx.remove(row.key)
          await tx.remove(timeKey(record))
          continue
        }
        await tx.write(timeKey(record), { key: row.key })
        if (record.kind === "run")
          await tx.write(
            StoragePath.usageLink(record.owner.scopeID, ownerKey(record.owner), record.runID),
            UsageSchema.Link.parse({
              owner: record.owner,
              runID: record.runID,
              parent: record.parent,
              parentOwner: record.parentOwner,
            }),
          )
      }
      after = page.at(-1)!.key
    }
    await tx.write(StoragePath.usageState(), { version: 1, revision: revision + 1 })
    await tx.write(StoragePath.usageRebuild(), {
      version: 1,
      status: "pending",
      phase: "indexes",
      owners: 0,
      records: 0,
      failures: 0,
      updatedAt: Date.now(),
    })
  }
}
