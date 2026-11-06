import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { z } from "zod"
import type { Message, SessionStatus } from "@ericsanchezok/synergy-sdk/client"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useLingui } from "@lingui/solid"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { isOptimisticMessagePending } from "@/context/session-optimistic-message"
import { useViewActivity } from "@/context/view-residency"
import { Persist, persisted } from "@/utils/persist"
import type { ComposerDocumentController } from "../prompt-input/composer-document"
import { PredictionRequest } from "./request"
import { twinCopy } from "./copy"
import { claimCompletion, registerComposer } from "./presence"

type Props = {
  controller: ComposerDocumentController
  focusEditor(): void
  sessionID?: string
  messages: Message[]
  status: SessionStatus
  parentID?: string
  blocked: boolean
  modelKey: string
  /**
   * External entry points share this owner without re-registering the service.
   * Binding suppresses the built-in button but retains feedback here.
   */
  bind?: (api: PredictionControlApi | undefined) => void
  showProgress?: boolean
}

export type PredictionControlApi = {
  predict(): void
  busy(): boolean
  disabled(): boolean
  disabledReason(): string | undefined
}

export function PredictionButton(props: { api: PredictionControlApi }) {
  const { _ } = useLingui()
  return (
    <Tooltip
      value={props.api.busy() ? _(twinCopy.predicting) : (props.api.disabledReason() ?? _(twinCopy.predict))}
      placement="top"
    >
      <button
        type="button"
        class="prompt-input-toolbar-icon-button flex items-center justify-center cursor-pointer disabled:cursor-not-allowed"
        aria-label={_(twinCopy.predict)}
        aria-busy={props.api.busy()}
        aria-description={props.api.disabledReason()}
        disabled={props.api.disabled()}
        onClick={() => props.api.predict()}
      >
        <Show
          when={props.api.busy()}
          fallback={
            <Icon
              name={getSemanticIcon("action.predict")}
              size="small"
              color={props.api.disabled() ? "var(--icon-disabled)" : "var(--icon-base)"}
            />
          }
        >
          <Spinner class="size-4 text-icon-base motion-reduce:[&>rect]:animate-none!" />
        </Show>
      </button>
    </Tooltip>
  )
}

const SavedSuggestion = z.object({
  version: z.literal(1),
  suggestion: z
    .object({
      rootID: z.string(),
      assistantID: z.string(),
      proposalID: z.string(),
      text: z.string().min(1),
    })
    .optional(),
})

export function DigitalTwinComposer(props: Props) {
  const sdk = useSDK()
  const owner = createMemo(() => ({ url: sdk.url, scope: sdk.scopeKey, sessionID: props.sessionID }))
  return (
    <Show when={owner()} keyed>
      {(owner) => <SessionPrediction {...props} sessionID={owner.sessionID} />}
    </Show>
  )
}

function SessionPrediction(props: Props) {
  const sdk = useSDK()
  const sync = useSync()
  const active = useViewActivity()
  const { _ } = useLingui()
  const owner = { url: sdk.url, scopeKey: sdk.scopeKey, sessionID: props.sessionID ?? "" }
  const [saved, setSaved] = persisted(
    {
      ...Persist.scoped(Persist.scopeKey(sdk.url, sdk.scopeKey), props.sessionID, "digital-twin"),
      migrate: (value) => SavedSuggestion.safeParse(value).data ?? { version: 1 },
    },
    createStore<z.infer<typeof SavedSuggestion>>({ version: 1 }),
  )
  onCleanup(registerComposer(owner, (suggestion) => setSaved("suggestion", suggestion)))
  const service = props.controller.service({
    id: "digital-twin",
    capabilities: new Set(["composer.read", "composer.write"]),
    onCompletionDismissed: () => setSaved("suggestion", undefined),
  })
  const [revision, setRevision] = createSignal(0)
  const [visible, setVisible] = createSignal(document.visibilityState === "visible")
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal(false)
  const [completedRoot, setCompletedRoot] = createSignal<string>()
  const [sourceRevision, setSourceRevision] = createSignal(0)
  let connection = 0
  let completionGeneration = 0
  let selection: object | undefined
  const unsubscribe = props.controller.subscribe(() => setRevision((value) => value + 1))
  const visibility = () => setVisible(document.visibilityState === "visible")
  document.addEventListener("visibilitychange", visibility)
  const anchor = createMemo(
    () => {
      const root = props.messages.findLast((message) => message.role === "user" && message.isRoot)
      const terminal = props.messages.findLast((message) => message.rootID === root?.id)
      if (
        !root ||
        root.role !== "user" ||
        !terminal ||
        terminal.role !== "assistant" ||
        terminal.summary ||
        terminal.error ||
        terminal.time.completed === undefined ||
        !terminal.finish ||
        ["tool-calls", "unknown"].includes(terminal.finish)
      )
        return
      return { rootID: root.id, assistantID: terminal.id }
    },
    undefined,
    { equals: (a, b) => a?.rootID === b?.rootID && a?.assistantID === b?.assistantID },
  )
  const eligible = createMemo(() => {
    revision()
    return (
      !!props.sessionID &&
      !props.parentID &&
      sdk.connected() &&
      sdk.capabilities.has("digital-twin") &&
      !props.blocked &&
      !props.controller.composing() &&
      props.controller.current().mode === "normal" &&
      !props.controller.current().text
    )
  })
  // Whether the user is looking at this Session decides whether the button can
  // be used, not whether a finished turn may be predicted: a retained view
  // stays mounted while the user works elsewhere, and the suggestion is meant to
  // be waiting when they return.
  const interactive = createMemo(() => eligible() && active() && visible())
  const state = () => {
    revision()
    const capabilities = sdk.capabilities.current()
    if (capabilities !== selection) {
      selection = capabilities
      connection++
    }
    const binding = JSON.stringify([
      sdk.url,
      sdk.scopeKey,
      props.sessionID,
      connection,
      props.modelKey,
      sync.data.config.digitalTwin?.model,
      sourceRevision(),
    ])
    return {
      identity: JSON.stringify([binding, anchor()]),
      binding,
      sessionID: props.sessionID,
      anchor: anchor(),
      eligible: eligible(),
      ready: props.status.type === "idle" && completedRoot() === anchor()?.rootID,
      automatic: sync.data.config.digitalTwin?.automatic === true,
    }
  }
  const requests = new PredictionRequest({
    read: state,
    call: async (input, signal) =>
      (await sdk.client.digitalTwin.predictNextInput({ digitalTwinInput: input }, { signal, throwOnError: true }))
        .data!,
    apply: (result) =>
      setSaved("suggestion", {
        rootID: result.stamp.rootID,
        assistantID: result.stamp.assistantID,
        text: result.candidate,
        proposalID: result.proposalID,
      }),
    clearFeedback: () => setFailure(false),
    changed: setBusy,
    failed: () => setFailure(true),
  })
  createEffect(() => {
    revision()
    const suggestion = saved.suggestion
    const snapshot = props.controller.current()
    const source = anchor()
    const root = props.messages.findLast(
      (message) => message.role === "user" && message.isRoot && !isOptimisticMessagePending(message),
    )
    const hidden =
      !!snapshot.text ||
      snapshot.mode !== "normal" ||
      props.controller.composing() ||
      props.blocked ||
      props.status.type !== "idle"
    if (
      suggestion &&
      ((root && root.id !== suggestion.rootID) ||
        sync.data.inbox[owner.sessionID]?.length ||
        (source && (suggestion.rootID !== source.rootID || suggestion.assistantID !== source.assistantID)))
    ) {
      setSaved("suggestion", undefined)
      return
    }
    untrack(() => {
      const current = props.controller.completion("digital-twin")
      if (!suggestion || !source || hidden) {
        if (current) service.setCompletion(undefined)
        return
      }
      if (current?.proposalID === suggestion.proposalID && current.revision === snapshot.revision) return
      service.setCompletion({
        revision: snapshot.revision,
        position: 0,
        text: suggestion.text,
        proposalID: suggestion.proposalID,
      })
    })
  })
  createEffect(() => {
    revision()
    if (failure() && props.controller.current().text) setFailure(false)
  })
  createEffect(() => {
    const snapshot = state()
    untrack(() => requests.update())
    if (!snapshot.eligible) setCompletedRoot(undefined)
  })
  createEffect(() => {
    const source = anchor()
    const sessionID = props.sessionID
    const capability = sdk.capabilities.current()
    if (!source || !sessionID || !sdk.connected() || !capability || !interactive() || props.status.type !== "idle")
      return
    const controller = new AbortController()
    if (untrack(completedRoot) === source.rootID) return
    const generation = completionGeneration
    void sdk.client.session
      .turnExecution({ sessionID, rootIDs: [source.rootID] }, { signal: controller.signal, throwOnError: true })
      .then((response) => {
        if (
          !controller.signal.aborted &&
          generation === completionGeneration &&
          anchor()?.rootID === source.rootID &&
          response.data?.some((state) => state.rootID === source.rootID && state.status === "completed")
        )
          setCompletedRoot(source.rootID)
      })
      .catch(() => {})
    onCleanup(() => controller.abort())
  })
  const event = sdk.event.on("session.root.completed", ({ properties }) => {
    if (properties.sessionID !== props.sessionID || !eligible()) return
    completionGeneration++
    setCompletedRoot(properties.rootID)
    if (claimCompletion(owner, properties.rootID, properties.assistantID))
      requests.completed({ rootID: properties.rootID, assistantID: properties.assistantID })
  })
  const sourceChanged = (sessionID: string) => {
    if (sessionID === props.sessionID) setSourceRevision((value) => value + 1)
  }
  // Hydrating a Session replays a part summary for content that never changed.
  // Treating every replay as an edit kept moving the request identity, which
  // aborted the prediction the click had just started; only a part whose
  // content version actually moved counts as an edit.
  const versions = new Map<string, string>()
  const partSummaryChanged = (summary: { sessionID: string; id?: string; content?: { version?: string } }) => {
    if (summary.sessionID !== props.sessionID) return
    const version = summary.id && summary.content?.version
    if (!version) {
      setSourceRevision((value) => value + 1)
      return
    }
    const previous = versions.get(summary.id!)
    versions.set(summary.id!, version)
    if (previous === undefined || previous === version) return
    setSourceRevision((value) => value + 1)
  }
  const changes = [
    sdk.event.on("message.updated", ({ properties }) => sourceChanged(properties.info.sessionID)),
    sdk.event.on("message.removed", ({ properties }) => sourceChanged(properties.sessionID)),
    sdk.event.on("message.part.updated", ({ properties }) => sourceChanged(properties.part.sessionID)),
    sdk.event.on("message.part.summary", ({ properties }) => partSummaryChanged(properties.summary)),
    sdk.event.on("message.part.removed", ({ properties }) => sourceChanged(properties.sessionID)),
    sdk.event.on("session.updated", ({ properties }) => sourceChanged(properties.info.id)),
  ]
  onCleanup(() => {
    event()
    for (const dispose of changes) dispose()
    unsubscribe()
    requests.dispose()
    service.dispose()
    document.removeEventListener("visibilitychange", visibility)
  })
  // Naming the blocker is the difference between a button that looks broken and
  // one the user knows how to enable.
  const reason = createMemo(() => {
    revision()
    if (!props.sessionID || props.parentID || !sdk.connected() || !sdk.capabilities.has("digital-twin"))
      return "view" as const
    if (!active() || !visible()) return "view" as const
    if (props.status.type !== "idle") return "turn" as const
    if (props.controller.current().text) return "draft" as const
    if (props.blocked) return "pending" as const
    if (props.controller.composing()) return "composing" as const
    if (props.controller.current().mode !== "normal") return "mode" as const
    if (!anchor()) return "reply" as const
    if (!state().ready) return "turn" as const
    return
  })
  const reasonLabel = () => {
    switch (reason()) {
      case "view":
        return _(twinCopy.reasonView)
      case "turn":
        return _(twinCopy.reasonTurn)
      case "draft":
        return _(twinCopy.reasonDraft)
      case "pending":
        return _(twinCopy.reasonPending)
      case "composing":
        return _(twinCopy.reasonComposing)
      case "mode":
        return _(twinCopy.reasonMode)
      case "reply":
        return _(twinCopy.reasonReply)
      default:
        return _(twinCopy.predict)
    }
  }
  const disabled = createMemo(() => !!reason() || busy())
  const api: PredictionControlApi = {
    predict() {
      props.focusEditor()
      setSaved("suggestion", undefined)
      requests.manual()
    },
    busy,
    disabled,
    disabledReason: () => (reason() ? reasonLabel() : undefined),
  }
  if (props.bind) {
    props.bind(api)
    onCleanup(() => props.bind!(undefined))
  }
  return (
    <>
      <Show when={!props.bind}>
        <PredictionButton api={api} />
      </Show>
      {/* Menu entry points disappear after activation; their feedback must outlive the menu. */}
      <Show when={props.bind && props.showProgress !== false && busy()}>
        <span data-slot="twin-prediction-status" role="status" class="text-12-regular text-text-weak">
          {_(twinCopy.predicting)}
        </span>
      </Show>
      <Show when={failure()}>
        <span
          role="status"
          data-slot="twin-prediction-status"
          data-twin-notice
          class="flex items-center gap-1 text-12-regular text-text-base"
        >
          <Icon name={getSemanticIcon("state.warning")} size="small" class="text-icon-warning-base" />
          {_(twinCopy.unavailable)}
          <button
            type="button"
            class="flex cursor-pointer items-center text-text-weak hover:text-text-base"
            aria-label={_(twinCopy.dismiss)}
            onClick={() => setFailure(false)}
          >
            <Icon name={getSemanticIcon("action.close")} size="small" />
          </button>
        </span>
      </Show>
    </>
  )
}
