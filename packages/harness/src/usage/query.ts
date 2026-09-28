import { z } from "zod"
import { ModelLimit } from "@ericsanchezok/synergy-util/model-limit"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { RolloutAccounting } from "../session/rollout/accounting"
import { RolloutTiming } from "../session/rollout/timing"
import { UsageSchema } from "./schema"
import { UsageLedger } from "./ledger"

export namespace UsageQuery {
  const Distribution = z
    .object({
      samples: z.number(),
      excluded: z.number(),
      totalMs: z.number(),
      meanMs: z.number().nullable(),
      p50Ms: z.number().nullable(),
      p95Ms: z.number().nullable(),
    })
    .strict()
  export const Summary = z
    .object({
      version: z.literal(1),
      revision: z.number().int().nonnegative(),
      computedAt: z.number(),
      scope: UsageSchema.Filter,
      timezone: z.string(),
      accounting: RolloutAccounting.Summary,
      provisional: RolloutAccounting.Summary,
      cache: z.object({
        ratio: z.number().nullable(),
        observedRatio: z.number().nullable(),
        read: z.number(),
        input: z.number(),
        samples: z.number(),
        excluded: z.number(),
      }),
      rates: z.object({ generation: RolloutTiming.Rate, endToEnd: RolloutTiming.Rate }),
      latency: z.object({
        headers: Distribution,
        firstByte: Distribution,
        ttft: Distribution,
        request: Distribution,
        generation: Distribution,
      }),
      scheduling: z.object({
        source: z.literal("wall_clock"),
        dispatch: Distribution,
        betweenAttempts: Distribution,
      }),
      outcomes: z.object({
        completed: z.number(),
        failed: z.number(),
        cancelled: z.number(),
        interrupted: z.number(),
        running: z.number(),
        retries: z.number(),
        transportRetries: z.number(),
        logicalRetries: z.number(),
        rootTasks: z.number(),
      }),
      coverage: z.object({
        records: z.number(),
        imported: z.number(),
        legacy: z.number(),
        active: z.number(),
        unclassified: z.number(),
        unsent: z.number(),
        external: z.number(),
        migration: UsageSchema.Rebuild.nullable(),
      }),
      tools: z.array(
        z.object({
          tool: z.string(),
          calls: z.number(),
          completed: z.number(),
          failed: z.number(),
          cancelled: z.number(),
          interrupted: z.number(),
          running: z.number(),
          durationMs: z.number(),
          timedSamples: z.number(),
          averageMs: z.number().nullable(),
        }),
      ),
      phases: z.array(
        z.object({
          recordID: z.string(),
          runID: z.string(),
          owner: UsageSchema.base.owner,
          phase: z.enum(["queued", "request", "generating", "tool", "terminal"]),
          elapsedMs: z.number().nullable(),
          retries: z.number(),
        }),
      ),
      latestRequest: UsageSchema.Attempt.nullable(),
      context: z
        .object({
          attemptID: z.string(),
          callID: z.string(),
          modelID: z.string(),
          inputTokens: z.number().nullable(),
          limit: z.number().nullable(),
          ratio: z.number().nullable(),
          stale: z.boolean(),
          observedAt: z.number(),
        })
        .nullable(),
      daily: z.array(z.object({ date: z.string(), accounting: RolloutAccounting.Summary, toolCalls: z.number() })),
      own: RolloutAccounting.Summary,
      descendants: RolloutAccounting.Summary,
      purposes: z.record(z.string(), RolloutAccounting.Summary),
      models: z.array(z.object({ providerID: z.string(), modelID: z.string(), accounting: RolloutAccounting.Summary })),
      agents: z.record(z.string(), RolloutAccounting.Summary),
    })
    .strict()
    .meta({ ref: "UsageSummary" })
  export type Summary = z.infer<typeof Summary>
  export const Page = z
    .object({
      version: z.literal(1),
      revision: z.number(),
      computedAt: z.number(),
      scope: UsageSchema.Filter,
      timezone: z.string(),
      items: z.array(UsageSchema.Record),
      nextCursor: z.string().nullable(),
    })
    .strict()
    .meta({ ref: "UsageRecordsPage" })
  const stamp = (record: UsageSchema.Record) =>
    record.kind === "attempt" ? (record.timing?.sentAt ?? record.started) : record.started
  const scopeKey = (owner: UsageSchema.Owner) => `${owner.scopeID}:${UsageLedger.ownerKey(owner)}`
  const runKey = (owner: UsageSchema.Owner, runID: string) => `${scopeKey(owner)}:${runID}`

  async function related(filter: z.output<typeof UsageSchema.Filter>) {
    if ((!filter.sessionID && !filter.runID) || !filter.includeDescendants) return undefined
    const runs: UsageSchema.Link[] = []
    const selected = new Set<string>()
    for await (const row of Storage.records<UsageSchema.Link>({
      kind: "usage_link",
      scopeID: filter.scopeID,
    })) {
      const record = row.value
      runs.push(record)
      if (
        (!filter.sessionID || (record.owner.kind === "session" && record.owner.sessionID === filter.sessionID)) &&
        (!filter.runID || record.runID === filter.runID)
      )
        selected.add(runKey(record.owner, record.runID))
    }
    let changed = true
    while (changed) {
      changed = false
      for (const record of runs) {
        const parent = record.parent
        const owner = parent?.owner ?? record.parentOwner
        if (!owner || selected.has(runKey(record.owner, record.runID))) continue
        const directParent =
          (!filter.sessionID || (owner.kind === "session" && owner.sessionID === filter.sessionID)) &&
          (!filter.runID || parent?.runID === filter.runID)
        const linked =
          directParent ||
          (parent?.runID
            ? selected.has(runKey(owner, parent.runID))
            : [...selected].some((key) => key.startsWith(`${scopeKey(owner)}:`)))
        if (!linked) continue
        selected.add(runKey(record.owner, record.runID))
        changed = true
      }
    }
    return selected
  }
  function matches(record: UsageSchema.Record, filter: z.output<typeof UsageSchema.Filter>, related?: Set<string>) {
    if (filter.scopeID && record.owner.scopeID !== filter.scopeID) return false
    const direct =
      (!filter.sessionID || (record.owner.kind === "session" && record.owner.sessionID === filter.sessionID)) &&
      (!filter.runID || record.runID === filter.runID || record.kind === "gap")
    if (!direct && !related?.has(runKey(record.owner, record.runID))) return false
    if (filter.kind && record.kind !== filter.kind) return false
    const time = stamp(record)
    if ((filter.from !== undefined && time < filter.from) || (filter.to !== undefined && time >= filter.to))
      return false
    for (const field of ["providerID", "modelID", "agent", "purpose"] as const) {
      const value =
        field === "providerID" || field === "modelID"
          ? "model" in record
            ? record.model[field]
            : undefined
          : field in record
            ? record[field as "purpose" & keyof typeof record]
            : undefined
      if (filter[field] !== undefined && value !== filter[field]) return false
    }
    return true
  }
  function validate(input: UsageSchema.Filter) {
    const result = UsageSchema.Filter.parse(input)
    if (result.from !== undefined && result.to !== undefined && result.from >= result.to)
      throw new UsageSchema.InvalidQuery({ message: "Usage time range must be half-open and increasing" })
    return result
  }
  export async function* scan(input: UsageSchema.Filter = {}, after?: string[]) {
    const filter = validate(input)
    const descendants = await related(filter)
    let cursor = after
    for (;;) {
      const batch = await Storage.query<{ key: string[] }>({
        kind: "usage_time",
        scopeID: filter.scopeID,
        sessionID: !filter.includeDescendants ? filter.sessionID : undefined,
        after: cursor,
        orderFrom: filter.from === undefined ? undefined : String(filter.from).padStart(17, "0"),
        orderTo: filter.to === undefined ? undefined : String(filter.to).padStart(17, "0"),
        limit: 256,
      })
      if (!batch.length) return
      const values = await Storage.readMany<UsageSchema.Record>(batch.map((row) => row.value.key))
      for (const value of values)
        if (value && matches(value, filter, descendants)) yield UsageSchema.Record.parse(value)
      cursor = batch.at(-1)!.key
    }
  }
  const timezone = (input: UsageSchema.Filter) => input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  function cursorScope(input: UsageSchema.Filter) {
    return JSON.stringify(validate(input))
  }
  export async function records(input: UsageSchema.Filter = {}, options: { cursor?: string; limit?: number } = {}) {
    return Storage.snapshot(() => readPage(input, options))
  }
  async function readPage(input: UsageSchema.Filter, options: { cursor?: string; limit?: number }) {
    const filter = validate(input)
    const limit = z
      .number()
      .int()
      .min(1)
      .max(500)
      .parse(options.limit ?? 100)
    let after: string[] | undefined
    if (options.cursor) {
      let raw: unknown
      try {
        raw = JSON.parse(Buffer.from(options.cursor, "base64url").toString())
      } catch {
        throw new UsageSchema.InvalidQuery({ message: "Invalid usage cursor" })
      }
      const parsed = z
        .object({ after: z.array(z.string()).length(4), filter: z.string() })
        .strict()
        .safeParse(raw)
      if (!parsed.success) throw new UsageSchema.InvalidQuery({ message: "Invalid usage cursor" })
      const cursor = parsed.data
      if (cursor.filter !== cursorScope(filter) || cursor.after[0] !== "usage_time")
        throw new UsageSchema.InvalidQuery({ message: "Usage cursor does not match its filters" })
      after = cursor.after
    }
    const items: UsageSchema.Record[] = []
    let nextCursor: string | null = null
    for await (const record of scan(filter, after)) {
      if (items.length === limit) {
        nextCursor = Buffer.from(
          JSON.stringify({ after: UsageLedger.timeKey(items.at(-1)!), filter: cursorScope(filter) }),
        ).toString("base64url")
        break
      }
      items.push(record)
    }
    return Page.parse({
      version: 1,
      revision: await UsageLedger.revision(),
      computedAt: Date.now(),
      scope: filter,
      timezone: timezone(filter),
      items,
      nextCursor,
    })
  }
  function accounting(records: UsageSchema.Record[], provisional = false) {
    const calls = records.filter((r): r is z.infer<typeof UsageSchema.Call> => r.kind === "call")
    const attempts = records.filter(
      (r): r is z.infer<typeof UsageSchema.Attempt> => r.kind === "attempt" && (!provisional || !r.usageFinal),
    )
    const callID = (owner: UsageSchema.Owner, runID: string, id: string) => `${runKey(owner, runID)}:${id}`
    const measured = new Set(attempts.map((attempt) => callID(attempt.owner, attempt.runID, attempt.callID)))
    const mapped: RolloutAccounting.CallInput[] = calls
      .filter(
        (call) =>
          (!call.hasAttempts && (!provisional || call.status === "running")) ||
          measured.has(callID(call.owner, call.runID, call.entityID)),
      )
      .map((call) => ({
        ...call,
        kind: call.callKind,
        id: callID(call.owner, call.runID, call.entityID),
        sdkUsage: null,
        source: call.source === "imported" ? true : undefined,
        usage:
          (!provisional && call.status !== "running") || (provisional && call.status === "running")
            ? call.usage
            : undefined,
        sdkEstimate: call.estimate,
      }))
    const selected = attempts
      .filter((attempt) => (provisional ? !attempt.usageFinal : true))
      .map((attempt) => ({
        ...attempt,
        callID: callID(attempt.owner, attempt.runID, attempt.callID),
        usage: provisional || attempt.usageFinal ? attempt.usage : undefined,
        estimate: provisional || attempt.usageFinal ? attempt.estimate : undefined,
      }))
    const knownCalls = new Set(mapped.map((call) => call.id))
    for (const attempt of selected)
      if (!knownCalls.has(attempt.callID)) {
        mapped.push({
          ...attempt,
          kind: attempt.callKind,
          id: attempt.callID,
          source: attempt.source === "imported" ? true : undefined,
          sdkUsage: null,
          usage: undefined,
          sdkEstimate: undefined,
        })
        knownCalls.add(attempt.callID)
      }
    const summary = RolloutAccounting.summarize({
      calls: mapped,
      attempts: selected,
      gaps: provisional ? [] : records.flatMap((record) => (record.kind === "gap" ? [record.sequence] : [])),
    })
    if (!provisional)
      for (const record of records)
        if (record.kind === "legacy") {
          const legacy = record.accounting
            ? structuredClone(record.accounting)
            : RolloutAccounting.summarize({
                calls: [
                  {
                    id: record.id,
                    runID: record.runID,
                    execution: record.execution,
                    model: record.model,
                    sdkUsage: null,
                    usage: record.usage,
                  },
                ],
                attempts: [],
                gaps: [],
              })
          legacy.legacy = { messages: 1, cost: record.legacyCost }
          legacy.apiEstimate = { known: 0, unknown: 0, total: 0 }
          const combined = RolloutAccounting.merge([summary, legacy])
          Object.assign(summary, combined)
        }
    return summary
  }
  export function summarize(records: UsageSchema.Record[], input: UsageSchema.Filter = {}, revision = 0): Summary {
    const scope = validate(input)
    const zone = timezone(scope)
    const computedAt = Date.now()
    const amount = accounting(records)
    const attempts = records.filter(
      (r): r is z.infer<typeof UsageSchema.Attempt> =>
        r.kind === "attempt" &&
        r.source !== "imported" &&
        r.execution !== "local" &&
        (!r.timing || r.timing.sentAt !== undefined),
    )
    const cache = {
      ratio: null as number | null,
      observedRatio: null as number | null,
      read: 0,
      input: 0,
      samples: 0,
      excluded: 0,
    }
    const rates = attempts.map((attempt) =>
      RolloutTiming.rates(attempt.timing, attempt.usageFinal ? attempt.usage?.output : undefined),
    )
    function describe(values: number[], excluded: number) {
      values.sort((a, b) => a - b)
      const totalMs = values.reduce((sum, ms) => sum + ms, 0)
      return {
        samples: values.length,
        excluded,
        totalMs,
        meanMs: values.length ? totalMs / values.length : null,
        p50Ms: values[Math.ceil(values.length * 0.5) - 1] ?? null,
        p95Ms: values[Math.ceil(values.length * 0.95) - 1] ?? null,
      }
    }
    function distribution(key: "headersMs" | "firstByteMs" | "ttftMs" | "requestMs" | "generationMs") {
      const values = attempts
        .flatMap((attempt) => (attempt.timing?.[key] === undefined ? [] : [attempt.timing[key]!]))
        .sort((a, b) => a - b)
      return describe(values, attempts.length - values.length)
    }
    const attemptsByCall = new Map<string, typeof attempts>()
    for (const attempt of attempts) {
      const key = `${runKey(attempt.owner, attempt.runID)}:${attempt.callID}`
      const values = attemptsByCall.get(key) ?? []
      values.push(attempt)
      attemptsByCall.set(key, values)
    }
    const logicalRetries = new Set(
      records.flatMap((record) =>
        (record.kind === "call" || record.kind === "attempt") &&
        record.source !== "imported" &&
        (record.retryIndex ?? 0) > 0
          ? [`${runKey(record.owner, record.runID)}:${record.kind === "call" ? record.entityID : record.callID}`]
          : [],
      ),
    ).size
    const transportRetries = attempts.filter((attempt) => attempt.index > 0).length
    const dispatch: number[] = []
    const between: number[] = []
    let dispatchMissing = 0,
      betweenMissing = 0
    for (const call of records) {
      if (call.kind !== "call" || call.source === "imported" || call.execution === "local") continue
      const sequence = (attemptsByCall.get(`${runKey(call.owner, call.runID)}:${call.entityID}`) ?? []).sort(
        (a, b) => a.index - b.index,
      )
      const first = sequence[0]?.timing?.sentAt
      if (first === undefined || first < call.started) dispatchMissing++
      else dispatch.push(first - call.started)
      for (let index = 1; index < sequence.length; index++) {
        const ended = sequence[index - 1].timing?.endedAt,
          sent = sequence[index].timing?.sentAt
        if (
          ended === undefined ||
          sent === undefined ||
          sent < ended ||
          sequence[index].index !== sequence[index - 1].index + 1
        )
          betweenMissing++
        else between.push(sent - ended)
      }
    }
    for (const attempt of attempts) {
      const usage = attempt.usageFinal ? attempt.usage : undefined
      if (usage?.billing === "units") continue
      if (usage?.input.total == null || usage.input.cacheRead == null) {
        cache.excluded++
        continue
      }
      cache.read += usage.input.cacheRead
      cache.input += usage.input.total
      cache.samples++
    }
    cache.observedRatio = cache.input > 0 ? cache.read / cache.input : null
    cache.ratio =
      !amount.tokens.input.unknown && !amount.tokens.cacheRead.unknown && amount.tokens.input.known > 0
        ? amount.tokens.cacheRead.known / amount.tokens.input.known
        : null
    const tools = new Map<string, Summary["tools"][number]>()
    for (const record of records)
      if (record.kind === "tool" && record.source !== "imported") {
        const value = tools.get(record.tool) ?? {
          tool: record.tool,
          calls: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
          interrupted: 0,
          running: 0,
          durationMs: 0,
          timedSamples: 0,
          averageMs: null,
        }
        value.calls++
        value[record.status]++
        if (record.durationMs !== null) {
          value.durationMs += record.durationMs
          value.timedSamples++
        }
        value.averageMs = value.timedSamples ? value.durationMs / value.timedSamples : null
        tools.set(record.tool, value)
      }
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
    const daily = new Map<string, UsageSchema.Record[]>()
    const purposes = new Map<string, UsageSchema.Record[]>()
    const models = new Map<string, { providerID: string; modelID: string; records: UsageSchema.Record[] }>()
    const agents = new Map<string, UsageSchema.Record[]>()
    const transported = new Set(
      records.flatMap((r) => (r.kind === "attempt" ? [`${runKey(r.owner, r.runID)}:${r.callID}`] : [])),
    )
    for (const record of records) {
      // A call is a grouping fact when transport is available; charging belongs to each sent attempt's day.
      if (record.kind === "call" && transported.has(`${runKey(record.owner, record.runID)}:${record.entityID}`))
        continue
      const date = formatter.format(stamp(record))
      const values = daily.get(date) ?? []
      values.push(record)
      daily.set(date, values)
    }
    for (const record of records)
      if ("purpose" in record) {
        const values = purposes.get(record.purpose) ?? []
        values.push(record)
        purposes.set(record.purpose, values)
        const model = models.get(JSON.stringify([record.model.providerID, record.model.modelID])) ?? {
          providerID: record.model.providerID,
          modelID: record.model.modelID,
          records: [],
        }
        model.records.push(record)
        models.set(JSON.stringify([model.providerID, model.modelID]), model)
        const agent = record.agent ?? record.purpose
        const attributed = agents.get(agent) ?? []
        attributed.push(record)
        agents.set(agent, attributed)
      }
    const latestRequest = attempts.toSorted((a, b) => stamp(b) - stamp(a) || b.index - a.index)[0] ?? null
    const primary = attempts
      .filter((attempt) => ["synergy", "synergy-max", "synergy-flash"].includes(attempt.purpose))
      .toSorted((a, b) => stamp(b) - stamp(a) || b.index - a.index)[0]
    const limit = primary?.model.limits ? (ModelLimit.usableInput(primary.model.limits) ?? null) : null
    const tokens = primary?.usage?.input.total ?? null
    const own = (record: UsageSchema.Record) =>
      (!scope.sessionID || (record.owner.kind === "session" && record.owner.sessionID === scope.sessionID)) &&
      (!scope.runID || record.runID === scope.runID)
    return Summary.parse({
      version: 1,
      revision,
      computedAt,
      scope,
      timezone: zone,
      accounting: amount,
      provisional: accounting(
        records.filter((r) => r.status === "running" || (r.kind === "attempt" && !r.usageFinal)),
        true,
      ),
      cache,
      rates: {
        generation: RolloutTiming.merge(rates.map((r) => r.generation)),
        endToEnd: RolloutTiming.merge(rates.map((r) => r.endToEnd)),
      },
      latency: {
        headers: distribution("headersMs"),
        firstByte: distribution("firstByteMs"),
        ttft: distribution("ttftMs"),
        request: distribution("requestMs"),
        generation: distribution("generationMs"),
      },
      outcomes: {
        ...Object.fromEntries(
          ["completed", "failed", "cancelled", "interrupted", "running"].map((status) => [
            status,
            attempts.filter((attempt) => attempt.status === status).length,
          ]),
        ),
        retries: transportRetries + logicalRetries,
        transportRetries,
        logicalRetries,
        rootTasks: records.filter(
          (record) =>
            record.kind === "run" &&
            record.owner.kind === "session" &&
            record.source === "local" &&
            !record.parent &&
            !record.parentOwner,
        ).length,
      },
      coverage: {
        records: records.length,
        imported: records.filter((r) => r.source === "imported").length,
        legacy: records.filter((r) => r.source === "legacy").length,
        active: records.filter((r) => r.status === "running").length,
        unclassified: records.filter((r) => r.kind === "call" && (r.model.billingMode ?? "unknown") === "unknown")
          .length,
        unsent: records.filter((r) => r.kind === "attempt" && r.timing && r.timing.sentAt === undefined).length,
        external: records.filter((r) => r.kind === "call" && r.execution === "external").length,
        migration: null,
      },
      tools: [...tools.values()],
      scheduling: {
        source: "wall_clock",
        dispatch: describe(dispatch, dispatchMissing),
        betweenAttempts: describe(between, betweenMissing),
      },
      latestRequest,
      context: primary
        ? {
            attemptID: primary.entityID,
            callID: primary.callID,
            modelID: primary.model.modelID,
            inputTokens: tokens,
            limit,
            ratio: tokens !== null && limit ? tokens / limit : null,
            observedAt: stamp(primary),
            stale:
              records.some((r) => "purpose" in r && r.purpose.includes("compaction") && r.started > stamp(primary)) ||
              tokens === null,
          }
        : null,
      phases: records
        .filter(
          (r) =>
            r.status === "running" &&
            r.kind !== "run" &&
            !(
              r.kind === "call" &&
              records.some(
                (attempt) =>
                  attempt.kind === "attempt" &&
                  attempt.status === "running" &&
                  attempt.callID === r.entityID &&
                  runKey(attempt.owner, attempt.runID) === runKey(r.owner, r.runID),
              )
            ),
        )
        .map((r) => ({
          recordID: r.id,
          runID: r.runID,
          owner: r.owner,
          phase: UsageLedger.phase(r),
          elapsedMs: Math.max(0, computedAt - stamp(r)),
          retries: r.kind === "attempt" ? r.index : 0,
        })),
      daily: [...daily]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, values]) => ({
          date,
          accounting: accounting(values),
          toolCalls: values.filter((value) => value.kind === "tool" && value.source !== "imported").length,
        })),
      purposes: Object.fromEntries([...purposes].map(([purpose, values]) => [purpose, accounting(values)])),
      models: [...models.values()].map((model) => ({
        providerID: model.providerID,
        modelID: model.modelID,
        accounting: accounting(model.records),
      })),
      agents: Object.fromEntries([...agents].map(([agent, values]) => [agent, accounting(values)])),
      own: accounting(records.filter(own)),
      descendants: accounting(records.filter((r) => !own(r))),
    })
  }
  const cache = Storage.state(() => new Map<string, Summary>())
  export async function summary(input: UsageSchema.Filter = {}) {
    return Storage.snapshot(async () => {
      const key = JSON.stringify({ ...validate(input), timezone: timezone(input) })
      const revision = await UsageLedger.revision()
      const previous = cache().get(key)
      let result: Summary
      if (previous?.revision === revision) {
        result = structuredClone(previous)
        const now = Date.now()
        for (const phase of result.phases)
          if (phase.elapsedMs !== null) phase.elapsedMs = Math.max(0, phase.elapsedMs + now - result.computedAt)
        result.computedAt = now
      } else {
        const records: UsageSchema.Record[] = []
        for await (const record of scan(input)) records.push(record)
        result = summarize(records, input, revision)
        cache().delete(key)
        cache().set(key, structuredClone(result))
        if (cache().size > 32) cache().delete(cache().keys().next().value!)
      }
      const migration = await Storage.read(StoragePath.usageRebuild(), { silentNotFound: true }).catch((error) => {
        if (error instanceof Storage.NotFoundError) return null
        throw error
      })
      result.coverage.migration = migration ? UsageSchema.Rebuild.parse(migration) : null
      return result
    })
  }
}
