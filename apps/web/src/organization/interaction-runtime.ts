import { createSignal, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { OrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import {
  OrganizationCommandProtocol as Command,
  OrganizationInteractionProtocol as Interaction,
  type OrganizationProtocol as Protocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { generateSecureUUID } from "@ericsanchezok/synergy-util/uuid"
import { createSessionDecisionState } from "@/context/session-decision"
import {
  confirmOrganizationDecision,
  createOrganizationDecisionCommands,
  type OrganizationDecisionCommand,
} from "./decision-command"

export type OrganizationInteractionDecision = Extract<Interaction.Result, { operation: "decisions" }>["items"][number]
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
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">
}) {
  const sourceID = input.sourceSessionID ?? input.rootSessionID
  const owner = JSON.stringify([input.binding.projectID, input.rootSessionID, sourceID])
  const ledger = createOrganizationDecisionCommands(input.storage, input.connectionKey, owner)
  const controller = new AbortController()
  const signal = AbortSignal.any([input.signal, controller.signal])
  onCleanup(() => controller.abort())
  const options = { throwOnError: true, signal } as const
  const [state, setState] = createStore({ pending: [] as Interaction.Pending[], retained: ledger.pending() })
  const restored = new Set(state.retained.map((entry) => nativeKey(entry.kind, entry.nativeID)))
  const [runtimeKind, setRuntimeKind] = createSignal<"member" | "hosted">()
  const [cursor, setCursor] = createSignal<string>()
  const [loading, setLoading] = createSignal(false)
  const [loaded, setLoaded] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  const [notice, setNotice] = createSignal<OrganizationInteractionDecision>()
  const [checking, setChecking] = createSignal<string>()
  const [retryable, setRetryable] = createSignal<ReadonlySet<string>>(new Set())
  const [suspended, setSuspended] = createSignal<ReadonlySet<string>>(new Set())
  function updateRetained() {
    setState("retained", reconcile(ledger.pending(), { key: "requestID" }))
  }
  function fail(error: unknown) {
    if (signal.aborted) return
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined
    if (code === "PERMISSION_DENIED" || code === "AUTHENTICATION_REQUIRED" || code === "NOT_FOUND") {
      setState("pending", [])
      controller.abort()
    }
    setError({ code: typeof code === "string" ? code : "COMMAND_OUTCOME_UNKNOWN" })
  }
  async function query(query: Interaction.Query) {
    const result = await input.api.orgSessionInteractions.list(
      { sessionID: input.rootSessionID, orgInteractionQuery: query },
      options,
    )
    signal.throwIfAborted()
    if (!Interaction.matches(query, result.data, input.binding)) throw unknown()
    setRuntimeKind(result.data.runtimeKind)
    return result.data
  }
  function resolved(value: OrganizationInteractionDecision) {
    if (value.state === "pending") return
    setNotice(value)
    decisions.ended(value.identity.kind, sourceID, value.identity.requestID)
    ledger.release(value.identity.requestID)
    setState("pending", (pending) =>
      pending.filter(
        (entry) => nativeKey(entry.kind, entry.requestID) !== nativeKey(value.identity.kind, value.identity.requestID),
      ),
    )
    updateRetained()
  }
  function accepted(entry: OrganizationDecisionCommand, value: unknown) {
    const result = confirmOrganizationDecision(entry, value, input.accountID, input.binding.bindingEpoch)
    ledger.clear(entry.nativeID, entry.requestID)
    updateRetained()
    const decision = result.effect.decision
    resolved(
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
    const entry = ledger.pending().find((value) => value.kind === kind && value.nativeID === identity.id)
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
          accepted(entry, receipt)
          return false
        }
        if (result.state === "rejected") {
          ledger.clear(entry.nativeID, entry.requestID)
          updateRetained()
          canRetry = true
        } else if (result.state === "not_dispatched" && entry.command) canRetry = true
      } catch (error) {
        receiptError = error
      }
    }
    const native = await nativeDecision(kind, identity.id)
    if (native.state !== "pending") {
      resolved(native)
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
    const retained = ledger.pending().find((value) => value.kind === kind && value.nativeID === identity.id)
    let entry = retained
    if (entry) {
      if (!(await pending(kind, identity))) return
      entry = ledger.pending().find((value) => value.kind === kind && value.nativeID === identity.id)
      if (entry && !entry.command) throw unknown()
    }
    if (!entry) {
      entry = await ledger.begin(
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
      updateRetained()
    }
    if (!entry.command) throw unknown()
    try {
      const result = await input.api.orgSessionInteractions.reply(
        { sessionID: input.rootSessionID, orgCommandDecisionRequest: entry.command },
        options,
      )
      signal.throwIfAborted()
      accepted(entry, result.data)
    } catch (error) {
      const suspendedKey = nativeKey(kind, identity.id)
      setSuspended((previous) => new Set([...previous, suspendedKey]))
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined
      throw { code: typeof code === "string" ? code : "COMMAND_OUTCOME_UNKNOWN" }
    }
  }
  const blocked = () =>
    state.retained.filter(
      (entry) =>
        restored.has(nativeKey(entry.kind, entry.nativeID)) || suspended().has(nativeKey(entry.kind, entry.nativeID)),
    )
  const visible = () =>
    state.pending.filter(
      (entry) => !blocked().some((value) => value.kind === entry.kind && value.nativeID === entry.requestID),
    )
  const decisions = createSessionDecisionState({
    connectionKey: input.connectionKey,
    scopeID: input.binding.projectID,
    questions: () =>
      visible().flatMap((entry) =>
        entry.kind === "question"
          ? [
              {
                id: entry.requestID,
                sessionID: sourceID,
                questions: entry.questions,
                tool: entry.tool,
                timeout: entry.timeout,
                createdAt: entry.createdAt,
              },
            ]
          : [],
      ),
    permissions: () =>
      visible().flatMap((entry) =>
        entry.kind === "permission"
          ? [
              {
                id: entry.requestID,
                sessionID: sourceID,
                permission: entry.permission,
                patterns: entry.patterns,
                metadata: {},
                tool: entry.tool,
              },
            ]
          : [],
      ),
    questionSnapshot: () => undefined,
    replyQuestion(identity, answers) {
      const request = state.pending.find((entry) => entry.kind === "question" && entry.requestID === identity.id)
      return submit(
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
        request?.kind === "question" && request.questions.some((question) => question.input_type === "password"),
      )
    },
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
    if (loading() || signal.aborted) return
    setLoading(true)
    try {
      const result = await query({
        operation: "pending",
        rootSessionID: input.rootSessionID,
        sourceSessionID: sourceID,
        limit: 32,
        cursor: more ? cursor() : undefined,
      })
      if (result.operation !== "pending") throw unknown()
      const entries = more ? [...state.pending, ...result.items] : [...result.items, ...state.pending]
      const unique = new Map(entries.map((entry) => [nativeKey(entry.kind, entry.requestID), entry]))
      const selected = decisions.selection(sourceID)
      const active = state.pending.find(
        (entry) => decisions.key(entry.kind, { id: entry.requestID, sessionID: sourceID }) === selected,
      )
      const candidates = [...unique.values()]
      const window = more ? candidates.slice(-128) : candidates.slice(0, 128)
      if (
        active &&
        !window.some((entry) => nativeKey(entry.kind, entry.requestID) === nativeKey(active.kind, active.requestID))
      )
        window.splice(0, 1, active)
      setState("pending", reconcile(window, { key: "requestID" }))
      if (!polling || !loaded()) setCursor(result.cursor)
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
      for (const value of result.items) if (value.state !== "pending") resolved(value)
    }
  }
  async function check(entry: OrganizationDecisionCommand, retry = false) {
    if (checking() || signal.aborted) return
    setChecking(entry.requestID)
    setError(undefined)
    try {
      const exists = await pending(entry.kind, { id: entry.nativeID, sessionID: entry.sourceSessionID })
      const current = ledger.pending().find((value) => value.requestID === entry.requestID)
      setRetryable(
        (previous) =>
          new Set(
            [...previous]
              .filter((id) => id !== entry.requestID)
              .concat(exists && current?.command ? [entry.requestID] : []),
          ),
      )
      if (retry && exists && current?.command) {
        const result = await input.api.orgSessionInteractions.reply(
          { sessionID: input.rootSessionID, orgCommandDecisionRequest: current.command },
          options,
        )
        signal.throwIfAborted()
        accepted(current, result.data)
      }
    } catch (error) {
      fail(error)
    } finally {
      if (!signal.aborted) setChecking(undefined)
    }
  }
  return {
    state,
    decisions,
    sourceID,
    visible,
    blocked,
    runtimeKind,
    cursor,
    loading,
    error,
    notice,
    dismissNotice: () => setNotice(undefined),
    checking,
    retryable,
    load,
    reconcilePending,
    check,
    fail,
  }
}
