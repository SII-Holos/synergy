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
import { useViewActivity } from "@/context/view-residency"
import { Persist, persisted } from "@/utils/persist"
import type { ComposerDocumentController } from "../prompt-input/composer-document"
import { PredictionRequest } from "./request"
import { twinCopy } from "./copy"

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
}

export function PredictionButton(props: { api: PredictionControlApi }) {
  const { _ } = useLingui()
  return (
    <Tooltip value={props.api.busy() ? _(twinCopy.predicting) : _(twinCopy.predict)} placement="top">
      <button
        type="button"
        class="prompt-input-toolbar-icon-button flex items-center justify-center cursor-pointer disabled:cursor-not-allowed"
        aria-label={_(twinCopy.predict)}
        aria-busy={props.api.busy()}
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
  const [saved, setSaved] = persisted(
    {
      ...Persist.scoped(Persist.scopeKey(sdk.url, sdk.scopeKey), props.sessionID, "digital-twin"),
      migrate: (value) => SavedSuggestion.safeParse(value).data ?? { version: 1 },
    },
    createStore<z.infer<typeof SavedSuggestion>>({ version: 1 }),
  )
  const service = props.controller.service({
    id: "digital-twin",
    capabilities: new Set(["composer.read", "composer.write"]),
    onCompletionDismissed: () => setSaved("suggestion", undefined),
  })
  const [revision, setRevision] = createSignal(0)
  const [visible, setVisible] = createSignal(document.visibilityState === "visible")
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<"unavailable" | "abstained">()
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
      active() &&
      visible() &&
      !props.blocked &&
      !props.controller.composing() &&
      props.controller.current().mode === "normal" &&
      !props.controller.current().text
    )
  })
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
      props.controller.current().revision,
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
        text: result.candidate!,
        proposalID: result.proposalID,
      }),
    clearFeedback: () => setFailure(undefined),
    changed: setBusy,
    failed: setFailure,
  })
  createEffect(() => {
    revision()
    const suggestion = saved.suggestion
    const snapshot = props.controller.current()
    const source = anchor()
    if (
      suggestion &&
      (snapshot.text ||
        snapshot.mode !== "normal" ||
        props.controller.composing() ||
        props.blocked ||
        props.status.type !== "idle" ||
        (source && (suggestion.rootID !== source.rootID || suggestion.assistantID !== source.assistantID)))
    ) {
      setSaved("suggestion", undefined)
      return
    }
    untrack(() => {
      const current = props.controller.completion("digital-twin")
      if (!suggestion) {
        if (current) service.setCompletion(undefined)
        return
      }
      if (!source || (current?.proposalID === suggestion.proposalID && current.revision === snapshot.revision)) return
      service.setCompletion({
        revision: snapshot.revision,
        position: 0,
        text: suggestion.text,
        proposalID: suggestion.proposalID,
      })
    })
  })
  createEffect(() => {
    if (!failure()) return
    const timeout = setTimeout(() => setFailure(undefined), 4000)
    onCleanup(() => clearTimeout(timeout))
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
    if (
      !source ||
      !sessionID ||
      !sdk.connected() ||
      !capability ||
      !eligible() ||
      !active() ||
      props.status.type !== "idle"
    )
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
    requests.completed({ rootID: properties.rootID, assistantID: properties.assistantID })
  })
  const sourceChanged = (sessionID: string) => {
    if (sessionID === props.sessionID) setSourceRevision((value) => value + 1)
  }
  const changes = [
    sdk.event.on("message.updated", ({ properties }) => sourceChanged(properties.info.sessionID)),
    sdk.event.on("message.removed", ({ properties }) => sourceChanged(properties.sessionID)),
    sdk.event.on("message.part.updated", ({ properties }) => sourceChanged(properties.part.sessionID)),
    sdk.event.on("message.part.summary", ({ properties }) => sourceChanged(properties.summary.sessionID)),
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
  const disabled = createMemo(() => !eligible() || !state().ready || busy())
  const api: PredictionControlApi = {
    predict() {
      props.focusEditor()
      setSaved("suggestion", undefined)
      requests.manual()
    },
    busy,
    disabled,
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
        {(reason) => (
          <span data-slot="twin-prediction-status" role="status" class="text-12-regular text-text-weak">
            {_(twinCopy[reason()])}
          </span>
        )}
      </Show>
    </>
  )
}
