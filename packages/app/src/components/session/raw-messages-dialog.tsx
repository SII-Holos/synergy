import { createEffect, createMemo, createResource, createSignal, For, Show, untrack } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { createCopyController } from "@ericsanchezok/synergy-ui/clipboard"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { checksum } from "@ericsanchezok/synergy-util/encode"
import { useLocale } from "@/context/locale"
import { useSDK } from "@/context/sdk"
import { rawMessages as R } from "@/locales/messages"
import { RawMessageCodePreview } from "./raw-message-code-preview"
import {
  isNarrowRawMessagesLayout,
  transferRawMessagesPaneFocus,
  updateRawMessagesSelectAll,
} from "./raw-messages-interaction"
import {
  compactSessionMessagesForCopy,
  isRawMessageHistoryComplete,
  loadRawMessages,
  nextRawMessagesLimit,
  rawMessageCreatedAt,
  rawMessageFlags,
  rawMessageIDSegments,
  rawMessageJson,
  rawMessagePreview,
  reconcileRawMessageState,
  selectAllRawMessages,
  summarizeRawMessageSelection,
  toggleRawMessageSelection,
  type RawMessagePresentation,
} from "./raw-messages-model"
import "./raw-messages-dialog.css"

const INITIAL_RAW_LIMIT = 100

function RawMessageID(props: { message: RawMessagePresentationMessage }) {
  const segments = createMemo(() => rawMessageIDSegments(props.message))
  return (
    <span class="raw-message-id" title={props.message.info.id}>
      <span class="raw-message-id-leading">{segments().leading}</span>
      <Show when={segments().trailing}>
        <span class="raw-message-id-trailing">{segments().trailing}</span>
      </Show>
    </span>
  )
}

type RawMessagePresentationMessage = Parameters<typeof rawMessageIDSegments>[0]

export function RawMessagesDialog(props: { sessionID: string }) {
  const sdk = useSDK()
  const { i18n, fmt } = useLocale()
  const [limit, setLimit] = createSignal(INITIAL_RAW_LIMIT)
  const [historyComplete, setHistoryComplete] = createSignal(false)
  const [selectedIds, setSelectedIds] = createSignal(new Set<string>())
  const [previewId, setPreviewId] = createSignal<string | undefined>()
  const [wrapCode, setWrapCode] = createSignal(false)
  let inspectorRoot: HTMLDivElement | undefined
  let previewBackButton: HTMLButtonElement | undefined
  let selectAllInput: HTMLInputElement | undefined
  let previewOriginId: string | undefined
  let previousLoad = { limit: 0, loaded: 0, complete: false }

  const presentation = createMemo<RawMessagePresentation>(() => ({
    roles: { user: i18n._(R.roleUser), assistant: i18n._(R.roleAssistant) },
    hiddenFlag: i18n._(R.flagHidden),
    excludedFlag: i18n._(R.flagExcluded),
  }))
  const copyStateLabel = (state: "idle" | "copied" | "failed") =>
    state === "copied" ? i18n._(R.copied) : state === "failed" ? i18n._(R.copyFailed) : ""

  const [response, { refetch }] = createResource(limit, async (nextLimit) => ({
    requestedLimit: nextLimit,
    messages: await loadRawMessages({
      sessionID: props.sessionID,
      limit: nextLimit,
      fetch: (request) => sdk.client.session.messages(request),
    }),
  }))

  const messages = createMemo(() => response()?.messages ?? [])
  createEffect(() => {
    const load = response()
    if (!load) return
    const complete = isRawMessageHistoryComplete({
      previousLimit: previousLoad.limit,
      previousLoaded: previousLoad.loaded,
      previousComplete: previousLoad.complete,
      requestedLimit: load.requestedLimit,
      loaded: load.messages.length,
    })
    const currentPreview = untrack(previewId)
    const reconciled = reconcileRawMessageState({
      messages: load.messages,
      selectedIds: untrack(selectedIds),
      previewId: currentPreview,
    })
    previousLoad = { limit: load.requestedLimit, loaded: load.messages.length, complete }
    setHistoryComplete(complete)
    setSelectedIds(reconciled.selectedIds)
    if (currentPreview && !reconciled.previewId) {
      setPreviewId(undefined)
      previewOriginId = undefined
      transferRawMessagesPaneFocus({ narrow: isNarrowRawMessagesLayout(), target: () => selectAllInput })
    }
  })

  const previewMessage = createMemo(
    () => messages().find((message) => message.info.id === previewId()) ?? messages()[0],
  )
  const previewText = createMemo(() => rawMessageJson(previewMessage()))
  const previewFile = createMemo(() => {
    const contents = previewText()
    return { name: `${previewMessage()?.info.id ?? "raw-message"}.json`, contents, cacheKey: checksum(contents) }
  })
  const loadedSelection = createMemo(() => summarizeRawMessageSelection(messages(), selectedIds()))
  const batchCopy = createCopyController({
    text: () => compactSessionMessagesForCopy(messages(), loadedSelection().ids),
    get copyLabel() {
      return i18n._(R.copySelected)
    },
    get copiedLabel() {
      return i18n._(R.copied)
    },
    get failedLabel() {
      return i18n._(R.copyFailed)
    },
    get failureDescription() {
      return i18n._(R.copySelectedFailed)
    },
  })
  const currentCopy = createCopyController({
    text: previewText,
    get copyLabel() {
      return i18n._(R.copyCurrent)
    },
    get copiedLabel() {
      return i18n._(R.copied)
    },
    get failedLabel() {
      return i18n._(R.copyFailed)
    },
    get failureDescription() {
      return i18n._(R.copyCurrentFailed)
    },
  })

  createEffect(() => {
    previewFile().cacheKey
    currentCopy.reset()
  })
  createEffect(() => {
    batchCopy.text()
    batchCopy.reset()
  })
  createEffect(() => updateRawMessagesSelectAll(selectAllInput, loadedSelection()))

  const replaceSelection = (ids: Iterable<string>) => setSelectedIds(new Set(ids))
  const toggleSelected = (messageID: string) =>
    setSelectedIds((current) => toggleRawMessageSelection(current, messageID))
  const toggleAllLoaded = () => replaceSelection(loadedSelection().all ? [] : selectAllRawMessages(messages()))
  const openPreview = (messageID: string) => {
    previewOriginId = messageID
    setPreviewId(messageID)
    transferRawMessagesPaneFocus({ narrow: isNarrowRawMessagesLayout(), target: () => previewBackButton })
  }
  const closePreview = () => {
    const originId = previewOriginId ?? previewId()
    setPreviewId(undefined)
    previewOriginId = undefined
    transferRawMessagesPaneFocus({
      narrow: isNarrowRawMessagesLayout(),
      target: () =>
        (originId
          ? inspectorRoot?.querySelector<HTMLButtonElement>(`[data-raw-message-id="${CSS.escape(originId)}"]`)
          : selectAllInput) ?? undefined,
    })
  }

  return (
    <Dialog title={i18n._(R.title)} size="command" class="raw-messages-dialog">
      <div ref={inspectorRoot} class="raw-messages-inspector">
        <div class="raw-messages-notice">
          <Icon name={getSemanticIcon("state.warning")} size="small" />
          <span>{i18n._(R.sensitiveNotice)}</span>
        </div>
        <div class="raw-messages-layout">
          <section class="raw-messages-list-pane" classList={{ "is-mobile-hidden": Boolean(previewId()) }}>
            <div class="raw-messages-list-toolbar">
              <label class="raw-messages-select-all">
                <input
                  ref={selectAllInput}
                  type="checkbox"
                  aria-label={i18n._(R.selectAll)}
                  checked={loadedSelection().all}
                  onChange={toggleAllLoaded}
                  disabled={messages().length === 0}
                />
                <span>{i18n._({ ...R.messageCount, values: { count: messages().length } })}</span>
              </label>
              <div class="raw-messages-list-actions">
                <Show when={loadedSelection().count > 0}>
                  <span class="raw-messages-copy-state" role="status" aria-live="polite" aria-atomic="true">
                    {copyStateLabel(batchCopy.state())}
                  </span>
                  <Button
                    type="button"
                    size="small"
                    variant="ghost"
                    icon={getSemanticIcon("action.copy")}
                    aria-label={i18n._({ ...R.copySelectedCount, values: { count: loadedSelection().count } })}
                    onClick={() => void batchCopy.copy()}
                  >
                    {i18n._({ ...R.copySelectedCount, values: { count: loadedSelection().count } })}
                  </Button>
                  <IconButton
                    type="button"
                    icon={getSemanticIcon("action.clear")}
                    variant="ghost"
                    aria-label={i18n._(R.clearSelection)}
                    title={i18n._(R.clearSelection)}
                    onClick={() => replaceSelection([])}
                  />
                </Show>
                <IconButton
                  type="button"
                  icon={getSemanticIcon("action.refresh")}
                  variant="ghost"
                  aria-label={i18n._(R.refresh)}
                  title={i18n._(R.refreshShort)}
                  onClick={() => void refetch()}
                  disabled={response.loading}
                />
              </div>
            </div>
            <div class="raw-messages-list" role="list" aria-label={i18n._(R.listLabel)}>
              <Show
                when={!response.error}
                fallback={
                  <div class="raw-messages-state">
                    <span>{i18n._(R.loadError)}</span>
                    <Button type="button" size="small" variant="secondary" onClick={() => void refetch()}>
                      {i18n._(R.retry)}
                    </Button>
                  </div>
                }
              >
                <Show
                  when={!response.loading || messages().length > 0}
                  fallback={<div class="raw-messages-state">{i18n._(R.loading)}</div>}
                >
                  <For each={messages()} fallback={<div class="raw-messages-state">{i18n._(R.empty)}</div>}>
                    {(message) => {
                      const checked = () => selectedIds().has(message.info.id)
                      const flags = () => rawMessageFlags(message, presentation())
                      const role = () => rawMessagePreview(message, presentation())
                      return (
                        <div
                          role="listitem"
                          class="raw-message-row"
                          classList={{ "is-active": previewMessage()?.info.id === message.info.id }}
                        >
                          <label class="raw-message-row-select">
                            <input
                              type="checkbox"
                              aria-label={i18n._({ ...R.selectMessage, values: { role: role(), id: message.info.id } })}
                              checked={checked()}
                              onChange={() => toggleSelected(message.info.id)}
                            />
                          </label>
                          <button
                            type="button"
                            class="raw-message-row-main"
                            data-raw-message-id={message.info.id}
                            onClick={() => openPreview(message.info.id)}
                          >
                            <strong class="raw-message-row-role">{role()}</strong>
                            <span class="raw-message-row-metadata">
                              <RawMessageID message={message} />
                              <Show when={flags().length > 0}>
                                <span class="raw-message-flags">{flags().join(" · ")}</span>
                              </Show>
                            </span>
                            <time>
                              {fmt.time(rawMessageCreatedAt(message), {
                                hour: "2-digit",
                                minute: "2-digit",
                                second: "2-digit",
                              })}
                            </time>
                          </button>
                        </div>
                      )
                    }}
                  </For>
                </Show>
              </Show>
            </div>
            <Show when={!historyComplete() && messages().length > 0}>
              <div class="raw-messages-list-footer">
                <Button
                  type="button"
                  size="small"
                  variant="ghost"
                  onClick={() => setLimit(nextRawMessagesLimit)}
                  disabled={response.loading}
                >
                  {i18n._(R.loadEarlier)}
                </Button>
              </div>
            </Show>
          </section>
          <section class="raw-messages-preview-pane" classList={{ "is-mobile-hidden": !previewId() }}>
            <div class="raw-messages-preview-toolbar">
              <Button
                ref={previewBackButton}
                type="button"
                size="small"
                variant="ghost"
                class="raw-messages-back"
                onClick={closePreview}
              >
                {i18n._(R.backToMessages)}
              </Button>
              <Show when={previewMessage()}>
                {(message) => (
                  <div class="raw-messages-preview-title">
                    <strong>{rawMessagePreview(message(), presentation())}</strong>
                    <RawMessageID message={message()} />
                  </div>
                )}
              </Show>
              <div class="raw-messages-preview-actions">
                <Button
                  type="button"
                  size="small"
                  variant="ghost"
                  class="raw-messages-wrap-toggle"
                  aria-pressed={wrapCode()}
                  data-selected={wrapCode()}
                  onClick={() => setWrapCode((current) => !current)}
                >
                  {i18n._(R.wrapLines)}
                </Button>
                <span class="raw-messages-copy-state" role="status" aria-live="polite" aria-atomic="true">
                  {copyStateLabel(currentCopy.state())}
                </span>
                <IconButton
                  type="button"
                  icon={getSemanticIcon("action.copy")}
                  variant="ghost"
                  aria-label={currentCopy.tooltip()}
                  title={currentCopy.tooltip()}
                  onClick={() => void currentCopy.copy()}
                  disabled={!previewMessage() || currentCopy.disabled()}
                  data-copy-state={currentCopy.state() === "idle" ? undefined : currentCopy.state()}
                />
              </div>
            </div>
            <div class="raw-messages-code-scroll" classList={{ "is-wrapped": wrapCode() }}>
              <Show when={previewText()} fallback={<div class="raw-messages-state">{i18n._(R.chooseMessage)}</div>}>
                <RawMessageCodePreview file={previewFile()} wrap={wrapCode()} />
              </Show>
            </div>
          </section>
        </div>
      </div>
    </Dialog>
  )
}
