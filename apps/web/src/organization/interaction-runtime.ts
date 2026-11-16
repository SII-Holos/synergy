import { createSignal, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { OrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import {
  OrganizationCommandProtocol as Command,
  OrganizationInteractionProtocol as Interaction,
  type OrganizationProtocol as Protocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { generateSecureUUID } from "@ericsanchezok/synergy-util/uuid"
import { createSessionDecisionState } from "@/context/session-decision-state"
import { createOrganizationDecisionOutbox } from "./decision-outbox"
import { confirmDecisionOutboxReceipt, type DecisionOutboxRecord } from "./decision-outbox-record"
import { organizationInteractionWindow } from "./interaction-window"
import { createOrganizationQuestionDrafts } from "./question-drafts"
import { organizationOwnerFailure } from "./owner-error"

export type OrganizationInteractionDecision = Extract<Interaction.Result, { operation: "decisions" }>["items"][number]
export type OrganizationRetainedDecision = DecisionOutboxRecord & { available: boolean }
type Identity = { id: string; sessionID: string }
const nativeKey = (kind: "question" | "permission", requestID: string) => `${kind}:${requestID}`
const unknown = () =>
  Object.assign(new Error("The response status could not be confirmed"), { code: "COMMAND_OUTCOME_UNKNOWN" })

export function createOrganizationInteractionRuntime(input: {
  api: OrganizationClient
  accountID: string
  connectionKey: string
  rootSessionID: string
  sourceSessionID?: string
  binding: Protocol.SessionBinding
  signal: AbortSignal
  invalidated?: (error: unknown) => void
}) {
  const sourceID = input.sourceSessionID ?? input.rootSessionID
  const outbox = createOrganizationDecisionOutbox({
    owner: {
      connectionKey: input.connectionKey,
      accountID: input.accountID,
      projectID: input.binding.projectID,
      rootSessionID: input.rootSessionID,
      sourceSessionID: sourceID,
    },
    binding: input.binding,
  })
  const controller = new AbortController()
  const signal = AbortSignal.any([input.signal, controller.signal])
  const options = { throwOnError: true, signal } as const
  const [state, setState] = createStore({
    pending: [] as Interaction.Pending[],
    retained: [] as OrganizationRetainedDecision[],
    nativeRecords: [] as OrganizationRetainedDecision[],
  })
  const [runtimeKind, setRuntimeKind] = createSignal<"member" | "hosted">()
  const [cursor, setCursor] = createSignal<string>()
  const [earlier, setEarlier] = createSignal(false)
  const [outboxCursor, setOutboxCursor] = createSignal<string>()
  const [outboxStart, setOutboxStart] = createSignal<string>()
  const [pinned, setPinned] = createSignal<OrganizationRetainedDecision>()
  const [loading, setLoading] = createSignal(false)
  const [loadingRetained, setLoadingRetained] = createSignal(false)
  const [loaded, setLoaded] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  const [notice, setNotice] = createSignal<OrganizationInteractionDecision>()
  const [checking, setChecking] = createSignal<string>()
  const [retryable, setRetryable] = createSignal<ReadonlySet<string>>(new Set())
  const [usable, setUsable] = createSignal(true)
  const [localRevision, setLocalRevision] = createSignal(0)
  const changed = () => setLocalRevision((value) => value + 1)
  const live = new Set<string>()
  const inflight = new Set<string>()
  const suspended = new Set<string>()
  const abort = () => {
    setUsable(false)
    outbox.dispose()
    live.clear()
    inflight.clear()
    suspended.clear()
    setState(reconcile({ pending: [], retained: [], nativeRecords: [] }))
    setPinned(undefined)
  }
  signal.addEventListener("abort", abort, { once: true })
  onCleanup(() => {
    controller.abort()
    signal.removeEventListener("abort", abort)
  })
  const decorate = (record: DecisionOutboxRecord): OrganizationRetainedDecision => ({
    ...record,
    available: outbox.available(record),
  })
  const sameDriver = (record: DecisionOutboxRecord) =>
    record.runtimeID === input.binding.driverRuntimeID && record.bindingEpoch === input.binding.bindingEpoch
  async function refreshRetained(more = false, first = false) {
    if (signal.aborted || loadingRetained()) return
    setLoadingRetained(true)
    try {
      const start = first ? undefined : more ? outboxCursor() : outboxStart()
      const page = await outbox.page({ cursor: start, limit: 32 })
      signal.throwIfAborted()
      setOutboxStart(start)
      setOutboxCursor(page.cursor)
      setState("retained", reconcile(page.items.map(decorate), { key: "requestID" }))
      const current = pinned()
      if (current) {
        const found = await outbox.get(current.requestID)
        signal.throwIfAborted()
        setPinned(found ? decorate(found) : undefined)
      }
    } finally {
      if (!signal.aborted) setLoadingRetained(false)
    }
  }
  async function refreshNativeRecords() {
    const rows = state.pending
    const records: OrganizationRetainedDecision[] = []
    for (let start = 0; start < rows.length; start += 64) {
      const found = await outbox.nativePage(
        rows.slice(start, start + 64).map((row) => ({ kind: row.kind, nativeID: row.requestID })),
      )
      records.push(...found.flatMap((row) => (row ? [decorate(row)] : [])))
    }
    signal.throwIfAborted()
    setState("nativeRecords", reconcile(records, { key: "requestID" }))
    const keep = new Set([...records, ...state.retained].map((row) => row.requestID))
    if (pinned()) keep.add(pinned()!.requestID)
    for (const id of live) if (!keep.has(id) && !inflight.has(id)) live.delete(id)
    for (const id of suspended) if (!keep.has(id) && !inflight.has(id)) suspended.delete(id)
    changed()
  }
  function fail(error: unknown) {
    if (signal.aborted) return
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined
    if (organizationOwnerFailure(error)) {
      setState(reconcile({ pending: [], retained: [], nativeRecords: [] }))
      setPinned(undefined)
      controller.abort()
      input.invalidated?.(error)
    }
    setError({ code: typeof code === "string" ? code : "COMMAND_OUTCOME_UNKNOWN" })
  }
  async function query(query: Interaction.Query) {
    const result = await input.api.orgSessionInteractions
      .list({ sessionID: input.rootSessionID, orgInteractionQuery: query }, options)
      .catch((error: unknown) => {
        fail(error)
        throw error
      })
    signal.throwIfAborted()
    if (!Interaction.matches(query, result.data, input.binding)) throw unknown()
    setRuntimeKind(result.data.runtimeKind)
    return result.data
  }
  async function resolved(value: OrganizationInteractionDecision) {
    if (value.state === "pending") return
    setNotice(value)
    decisions.ended(value.identity.kind, sourceID, value.identity.requestID)
    const record = await outbox.native(value.identity.kind, value.identity.requestID)
    signal.throwIfAborted()
    if (record) outbox.release(record.requestID)
    setState("pending", (rows) =>
      rows.filter(
        (row) => nativeKey(row.kind, row.requestID) !== nativeKey(value.identity.kind, value.identity.requestID),
      ),
    )
    await refreshRetained()
    await refreshNativeRecords()
  }
  async function accepted(entry: DecisionOutboxRecord, value: unknown) {
    const result = confirmDecisionOutboxReceipt(entry, value)
    await outbox.remove(entry)
    signal.throwIfAborted()
    live.delete(entry.requestID)
    suspended.delete(entry.requestID)
    changed()
    const decision = result.effect.decision
    await resolved(
      decision.status === "expired"
        ? { identity: { kind: entry.kind, requestID: entry.nativeID }, state: "expired" }
        : { identity: { kind: entry.kind, requestID: entry.nativeID }, state: "resolved", winner: decision.winner },
    )
  }
  async function nativeDecision(kind: "question" | "permission", requestID: string) {
    const result = await query({
      operation: "decisions",
      rootSessionID: input.rootSessionID,
      sourceSessionID: sourceID,
      identities: [{ kind, requestID }],
    })
    if (result.operation !== "decisions" || !result.items[0]) throw unknown()
    return result.items[0]
  }
  async function pending(kind: "question" | "permission", identity: Identity) {
    const entry = await outbox.native(kind, identity.id)
    signal.throwIfAborted()
    let canRetry = !entry
    let receiptError: unknown
    if (entry) {
      try {
        const response = await input.api.orgCommands.lookup({ requestID: entry.requestID }, options)
        signal.throwIfAborted()
        const result = Command.View.parse(response.data)
        if (result.requestID !== entry.requestID) throw unknown()
        const receipt = result.accepted ?? result.result?.accepted
        if (receipt) {
          await accepted(entry, receipt)
          return false
        }
        if (result.state === "rejected") {
          await outbox.remove(entry)
          live.delete(entry.requestID)
          suspended.delete(entry.requestID)
          changed()
          await refreshRetained()
          await refreshNativeRecords()
          canRetry = true
        } else if (result.state === "not_dispatched" && sameDriver(entry) && outbox.available(entry)) canRetry = true
      } catch (error) {
        receiptError = error
      }
    }
    const native = await nativeDecision(kind, identity.id)
    if (native.state !== "pending") {
      await resolved(native)
      return false
    }
    if (!canRetry || receiptError) throw unknown()
    return true
  }
  async function submit(
    kind: "question" | "permission",
    identity: Identity,
    decision: Command.Decision,
    sensitive: boolean,
  ) {
    let entry = await outbox.native(kind, identity.id)
    signal.throwIfAborted()
    if (entry) {
      if (!(await pending(kind, identity))) return
      entry = await outbox.native(kind, identity.id)
      if (entry && (!sameDriver(entry) || !outbox.available(entry))) throw unknown()
    }
    if (!entry) {
      entry = await outbox.begin(
        {
          schemaVersion: 1,
          orgID: input.binding.orgID,
          requestID: generateSecureUUID(),
          sessionID: input.rootSessionID,
          projectID: input.binding.projectID,
          runtimeID: input.binding.driverRuntimeID,
          decision,
        },
        sensitive,
      )
      live.add(entry.requestID)
      changed()
    }
    const command = await outbox.command(entry)
    signal.throwIfAborted()
    if (!command) throw unknown()
    inflight.add(entry.requestID)
    try {
      await refreshNativeRecords()
      const result = await input.api.orgSessionInteractions.reply(
        { sessionID: input.rootSessionID, orgCommandDecisionRequest: command },
        options,
      )
      signal.throwIfAborted()
      await accepted(entry, result.data)
    } catch (error) {
      fail(error)
      if (!signal.aborted) {
        suspended.add(entry.requestID)
        changed()
        setPinned(decorate(entry))
        await refreshRetained()
        await refreshNativeRecords()
      }
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined
      throw { code: typeof code === "string" ? code : "COMMAND_OUTCOME_UNKNOWN" }
    } finally {
      inflight.delete(entry.requestID)
    }
  }
  const isBlocked = (record: DecisionOutboxRecord) => {
    localRevision()
    return !live.has(record.requestID) || suspended.has(record.requestID)
  }
  const visible = () =>
    state.pending.filter(
      (row) =>
        !state.nativeRecords.some(
          (record) => record.kind === row.kind && record.nativeID === row.requestID && isBlocked(record),
        ),
    )
  const blocked = () => {
    const page = [...(pinned() ? [pinned()!] : []), ...state.retained]
    return [...new Map(page.filter(isBlocked).map((entry) => [entry.requestID, entry])).values()]
  }
  const decisions = createSessionDecisionState({
    connectionKey: input.connectionKey,
    scopeID: input.binding.projectID,
    drafts: createOrganizationQuestionDrafts({
      owner: { connectionKey: input.connectionKey, accountID: input.accountID, projectID: input.binding.projectID },
    }),
    signal,
    questions: () =>
      visible().flatMap((row) =>
        row.kind === "question"
          ? [
              {
                id: row.requestID,
                sessionID: sourceID,
                questions: row.questions,
                tool: row.tool,
                timeout: row.timeout,
                createdAt: row.createdAt,
              },
            ]
          : [],
      ),
    permissions: () =>
      visible().flatMap((row) =>
        row.kind === "permission"
          ? [
              {
                id: row.requestID,
                sessionID: sourceID,
                permission: row.permission,
                patterns: row.patterns,
                metadata: {},
                tool: row.tool,
              },
            ]
          : [],
      ),
    questionSnapshot: () => undefined,
    replyQuestion: (identity, answers, policy) =>
      submit(
        "question",
        identity,
        {
          operation: "decision",
          kind: "question",
          requestID: identity.id,
          sourceSessionID: sourceID,
          reply: answers ? "answer" : "reject",
          ...(answers ? { answers } : {}),
        },
        policy?.includes("password") ?? true,
      ),
    replyPermission: (identity, reply) =>
      submit(
        "permission",
        identity,
        { operation: "decision", kind: "permission", requestID: identity.id, sourceSessionID: sourceID, reply },
        false,
      ),
    questionPending: (identity) => pending("question", identity),
    permissionPending: (identity) => pending("permission", identity),
  })
  async function load(more = false, polling = false) {
    if (loading() || signal.aborted || (more && !cursor())) return
    setLoading(true)
    try {
      await refreshRetained()
      const result = await query({
        operation: "pending",
        rootSessionID: input.rootSessionID,
        sourceSessionID: sourceID,
        limit: 32,
        cursor: more ? cursor() : undefined,
      })
      if (result.operation !== "pending") throw unknown()
      const selected = decisions.selection(sourceID)
      const active = state.pending.find(
        (entry) => decisions.key(entry.kind, { id: entry.requestID, sessionID: sourceID }) === selected,
      )
      const window = organizationInteractionWindow({
        current: state.pending,
        incoming: result.items,
        mode: more ? "more" : polling && loaded() && earlier() ? "poll" : "first",
        selected: active,
      })
      setState("pending", reconcile(window, { key: "requestID" }))
      await refreshNativeRecords()
      if (!polling || !loaded() || !earlier()) setCursor(result.cursor)
      if (!polling) setEarlier(more)
      setLoaded(true)
      setError(undefined)
    } catch (error) {
      fail(error)
    } finally {
      if (!signal.aborted) setLoading(false)
    }
  }
  async function reconcilePending() {
    const entries = [...state.pending]
    for (let offset = 0; offset < entries.length; offset += 32) {
      const identities = entries
        .slice(offset, offset + 32)
        .map((entry) => ({ kind: entry.kind, requestID: entry.requestID }))
      if (!identities.length || signal.aborted) return
      const result = await query({
        operation: "decisions",
        rootSessionID: input.rootSessionID,
        sourceSessionID: sourceID,
        identities,
      })
      if (result.operation !== "decisions") throw unknown()
      for (const value of result.items) if (value.state !== "pending") await resolved(value)
    }
  }
  async function check(entry: OrganizationRetainedDecision, retry = false) {
    if (checking() || signal.aborted) return
    setChecking(entry.requestID)
    setError(undefined)
    try {
      const exists = await pending(entry.kind, { id: entry.nativeID, sessionID: entry.sourceSessionID })
      const current = await outbox.get(entry.requestID)
      signal.throwIfAborted()
      setRetryable(
        (previous) =>
          new Set(
            [...previous]
              .filter((id) => id !== entry.requestID)
              .concat(exists && current && sameDriver(current) && outbox.available(current) ? [entry.requestID] : []),
          ),
      )
      if (retry && exists && current && sameDriver(current)) {
        const command = await outbox.command(current)
        signal.throwIfAborted()
        if (!command) throw unknown()
        const result = await input.api.orgSessionInteractions.reply(
          { sessionID: input.rootSessionID, orgCommandDecisionRequest: command },
          options,
        )
        signal.throwIfAborted()
        await accepted(current, result.data)
      }
    } catch (error) {
      fail(error)
    } finally {
      if (!signal.aborted) setChecking(undefined)
    }
  }
  const retainedPage = async (more = false, first = false) => {
    try {
      await refreshRetained(more, first)
    } catch (error) {
      fail(error)
    }
  }
  if (signal.aborted) abort()
  return {
    state,
    decisions,
    sourceID,
    visible,
    blocked,
    runtimeKind,
    cursor,
    earlier,
    outboxCursor,
    outboxStart,
    loading,
    loadingRetained,
    error,
    notice,
    dismissNotice: () => setNotice(undefined),
    checking,
    retryable,
    active: usable,
    load,
    reconcilePending,
    check,
    retainedPage,
    fail,
  }
}
