import { createEffect, createMemo, createSignal, onCleanup, Show, untrack } from "solid-js"
import type { Message, SessionStatus } from "@ericsanchezok/synergy-sdk/client"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useLingui } from "@lingui/solid"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useViewActivity } from "@/context/view-residency"
import type { ComposerDocumentController } from "../prompt-input/composer-document"
import { PredictionRequest } from "./request"
import { twinCopy } from "./copy"

export function DigitalTwinComposer(props: {
  controller: ComposerDocumentController
  focusEditor(): void
  sessionID?: string
  messages: Message[]
  status: SessionStatus
  parentID?: string
  blocked: boolean
  modelKey: string
}) {
  const sdk = useSDK()
  const sync = useSync()
  const active = useViewActivity()
  const { _ } = useLingui()
  const service = props.controller.service({
    id: "digital-twin",
    capabilities: new Set(["composer.read", "composer.write"]),
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
      automatic: sync.data.config.digitalTwin?.automatic !== false,
    }
  }
  const requests = new PredictionRequest({
    read: state,
    call: async (input, signal) =>
      (await sdk.client.digitalTwin.predictNextInput({ digitalTwinInput: input }, { signal, throwOnError: true }))
        .data!,
    apply: (result) =>
      service.setCompletion({
        revision: props.controller.current().revision,
        position: 0,
        text: result.candidate!,
        proposalID: result.proposalID,
      }),
    clear: () => {
      service.setCompletion(undefined)
      setFailure(undefined)
    },
    changed: setBusy,
    failed: setFailure,
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
  return (
    <>
      <Tooltip value={busy() ? _(twinCopy.predicting) : _(twinCopy.predict)}>
        <IconButton
          type="button"
          icon={getSemanticIcon("action.predict")}
          aria-label={_(twinCopy.predict)}
          disabled={!eligible() || !state().ready || busy()}
          onClick={() => {
            props.focusEditor()
            requests.manual()
          }}
        />
      </Tooltip>
      <Show when={failure()}>
        {(reason) => (
          <span role="status" class="text-12-regular text-text-weak">
            {_(twinCopy[reason()])}
          </span>
        )}
      </Show>
    </>
  )
}
