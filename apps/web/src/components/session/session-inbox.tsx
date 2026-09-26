import { createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Markdown } from "@ericsanchezok/synergy-ui/markdown"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { requestErrorMessage } from "@/utils/error"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { SessionInboxItem } from "@ericsanchezok/synergy-sdk/client"
import type { useSDK } from "@/context/sdk"
import type { useSync } from "@/context/sync"
import { createSessionDataView } from "@ericsanchezok/synergy-ui/context/session-data-view"
import { useLocale } from "@/context/locale"
import { deriveSessionInboxView, isInboxItemInteractive } from "./session-inbox-utils"
import { S } from "./session-i18n"
import "./session-inbox.css"

type SessionInboxProps = {
  sessionID: string
  sync: ReturnType<typeof useSync>
  sdk: ReturnType<typeof useSDK>
  freezeHint?: boolean
  hasCanonicalRoot?: boolean
}

function InboxDetail(props: { item: SessionInboxItem; i18n: ReturnType<typeof useLocale>["i18n"] }) {
  const _ = (d: { id: string; message: string }) => props.i18n._(d)
  const detailText = () => {
    const lines: string[] = []
    if (props.item.detail?.text) lines.push(props.item.detail.text)
    if (props.item.detail?.attachments?.length) lines.push(props.item.detail.attachments.join("\n"))
    return lines.join("\n\n").trim() || props.item.summary.preview || props.item.summary.title
  }
  const modeLabel = () => {
    switch (props.item.mode) {
      case "task":
        return _(S.inboxQueued)
      case "steer":
        return _(S.inboxGuiding)
      case "context":
        return _(S.inboxContextUpdate)
      default:
        return _(S.inboxUpdate)
    }
  }
  const deliveryDesc = () => {
    switch (props.item.mode) {
      case "task":
        return _(S.inboxDeliveryTask)
      case "steer":
        return _(S.inboxDeliverySteer)
      default:
        return _(S.inboxDeliveryContext)
    }
  }
  return (
    <div class="session-inbox-detail">
      <div class="text-12-medium text-text-strong">{modeLabel()}</div>
      <Markdown
        text={detailText()}
        cacheKey={`session-inbox-detail-${props.item.id}`}
        class="session-inbox-detail-markdown"
      />
      <Show when={props.item.status === "failed" && props.item.failReason}>
        <div class="session-inbox-detail-meta">{props.item.failReason}</div>
      </Show>
      <div class="session-inbox-detail-meta">
        <span>{props.item.source.label ?? props.item.source.type}</span>
        <span>·</span>
        <span>{deliveryDesc()}</span>
      </div>
    </div>
  )
}

function InboxRow(props: {
  item: SessionInboxItem
  disabled?: boolean
  onGuide: (item: SessionInboxItem) => void
  onRemove: (item: SessionInboxItem) => void
  onRetry: (item: SessionInboxItem) => void
  i18n: ReturnType<typeof useLocale>["i18n"]
}) {
  const _ = (d: { id: string; message: string }) => props.i18n._(d)
  const [menuOpen, setMenuOpen] = createSignal(false)
  const failed = () => props.item.status === "failed"
  const canInteract = () => !props.disabled && isInboxItemInteractive(props.item)
  const preview = () => props.item.summary.preview || props.item.summary.title
  const guideLabel = () => (props.item.mode === "steer" ? _(S.inboxGuideQueue) : _(S.inboxGuideSendNow))
  const guideTitle = () => (props.item.mode === "steer" ? _(S.inboxGuideQueueTip) : _(S.inboxGuideSendNowTip))

  const remove = () => {
    setMenuOpen(false)
    props.onRemove(props.item)
  }

  const timingLabel = () => {
    if (failed()) return _(S.inboxFailedStatus)
    switch (props.item.mode) {
      case "task":
        return _(S.inboxAfterTurn)
      case "steer":
        return _(S.inboxNextCall)
      default:
        return _(S.inboxContextTag)
    }
  }

  const modeLabel = () => {
    switch (props.item.mode) {
      case "task":
        return _(S.inboxQueued)
      case "steer":
        return _(S.inboxGuiding)
      case "context":
        return _(S.inboxContextUpdate)
      default:
        return _(S.inboxUpdate)
    }
  }

  return (
    <div class="session-inbox-row" data-mode={props.item.mode} data-failed={failed()} data-interactive={canInteract()}>
      <Popover
        placement="left"
        class="session-inbox-row-tooltip"
        triggerAs={(triggerProps) => (
          <button {...triggerProps} type="button" class="session-inbox-row-main">
            <div class="session-inbox-row-meta">
              <span class="session-inbox-row-label">{modeLabel()}</span>
              <span class="session-inbox-row-status" data-mode={props.item.mode} data-failed={failed()}>
                {timingLabel()}
              </span>
            </div>
            <div class="session-inbox-row-preview">{preview()}</div>
          </button>
        )}
      >
        <InboxDetail item={props.item} i18n={props.i18n} />
      </Popover>
      <Show when={canInteract()}>
        <div class="session-inbox-actions">
          <Show
            when={!failed()}
            fallback={
              <button
                type="button"
                class="session-inbox-send-now"
                aria-label={_(S.inboxRetry)}
                title={props.item.failReason ?? _(S.inboxFailed)}
                onClick={(event) => {
                  event.stopPropagation()
                  props.onRetry(props.item)
                }}
              >
                {_(S.inboxRetry)}
              </button>
            }
          >
            <button
              type="button"
              class="session-inbox-send-now"
              aria-label={guideLabel()}
              title={guideTitle()}
              onClick={(event) => {
                event.stopPropagation()
                props.onGuide(props.item)
              }}
            >
              {guideLabel()}
            </button>
          </Show>
          <Popover
            open={menuOpen()}
            onOpenChange={setMenuOpen}
            placement="bottom-end"
            gutter={6}
            class="session-inbox-menu-popover"
            triggerAs={(triggerProps) => (
              <button
                {...triggerProps}
                type="button"
                class="session-inbox-more"
                aria-label={_(S.inboxDetailAria)}
                aria-expanded={menuOpen()}
              >
                <Icon name={getSemanticIcon("action.more")} size="small" />
              </button>
            )}
          >
            <div class="session-inbox-menu-list">
              <button type="button" class="session-inbox-menu-item" onClick={remove}>
                {_(S.inboxDelete)}
              </button>
            </div>
          </Popover>
        </div>
      </Show>
    </div>
  )
}

export function SessionInbox(props: SessionInboxProps) {
  return (
    <Show when={props.sessionID} keyed>
      {(sessionID) => <SessionInboxContent {...props} sessionID={sessionID} />}
    </Show>
  )
}

function SessionInboxContent(props: SessionInboxProps) {
  const sessionID = props.sessionID
  const client = props.sdk.client
  const [open, setOpen] = createSignal(false)
  const [operations, setOperations] = createSignal<
    Record<string, { kind: "remove" | "restore"; item: SessionInboxItem; pending: boolean; error?: unknown }>
  >({})
  const [removed, { refetch }] = createResource(
    () => open(),
    async () => (await client.session.inboxRemoved({ sessionID }, { throwOnError: true })).data,
  )
  const change = async (item: SessionInboxItem, kind: "remove" | "restore") => {
    if (operations()[item.id]?.pending) return
    const previous = operations()[item.id]
    setOperations((all) => ({ ...all, [item.id]: { kind, item, pending: true } }))
    try {
      const records =
        kind === "restore" || previous?.error
          ? (await client.session.inboxRemoved({ sessionID }, { throwOnError: true })).data
          : undefined
      const isRemoved = records?.some((entry) => entry.id === item.id)
      if (kind === "restore" && isRemoved !== false) {
        await client.session.inboxRestore({ sessionID, itemID: item.id }, { throwOnError: true })
      }
      if (kind === "remove" && !isRemoved) {
        await client.session.inboxRemove({ sessionID, itemID: item.id }, { throwOnError: true })
      }
      await refetch()
      await props.sync.session.refresh(sessionID)
      setOperations((all) => ({ ...all, [item.id]: { kind, item, pending: false } }))
    } catch (error) {
      setOperations((all) => ({ ...all, [item.id]: { kind, item, pending: false, error } }))
    }
  }
  const { i18n } = useLocale()
  const _ = (d: { id: string; message: string }) => i18n._(d)
  const dataView = createMemo(() => createSessionDataView(props.sync.data))
  const view = createMemo(() =>
    deriveSessionInboxView(
      dataView().hasInboxBucket(props.sessionID) ? dataView().inboxFor(props.sessionID) : undefined,
    ),
  )
  const items = createMemo(() => view().items)
  const count = createMemo(() => view().count)
  const firstTaskLocked = (item: SessionInboxItem) =>
    item.mode === "task" && item.status !== "failed" && props.hasCanonicalRoot === false
  // Bulk "Send all" guides every actionable item; failed items stay out of
  // it — only the retry path may re-drive a parked failure.
  const actionableItems = createMemo(() =>
    items().filter((item) => item.status !== "failed" && isInboxItemInteractive(item) && !firstTaskLocked(item)),
  )

  const titleDetail = createMemo(() => {
    if (view().status === "loading") return _(S.inboxDebug)
    if (count() === 0) return _(S.inboxClear)
    return i18n._({ ...S.inboxItemsWaiting, values: { count: count() } })
  })

  const note = createMemo(() => {
    const steers = items().filter((i) => i.mode === "steer").length
    const tasks = items().filter((i) => i.mode === "task").length
    const contexts = items().filter((i) => i.mode === "context").length
    if (steers > 0 && tasks > 0) return i18n._({ ...S.inboxQueueNextCall, values: { steers, tasks } })
    if (steers > 1) return i18n._({ ...S.inboxQueueJoinModel, values: { count: steers } })
    if (steers === 1) return _(S.inboxQueueJoinSingular)
    if (tasks > 1) return i18n._({ ...S.inboxQueueTasks, values: { count: tasks } })
    if (tasks === 1) return _(S.inboxQueueTasksSingular)
    if (contexts > 1) return i18n._({ ...S.inboxQueueContexts, values: { count: contexts } })
    if (contexts === 1) return _(S.inboxQueueContextSingular)
    return _(S.inboxClear)
  })

  const guide = async (item: SessionInboxItem) => {
    try {
      await props.sdk.client.session.inboxGuide({ sessionID, itemID: item.id }, { throwOnError: true })
    } catch (err) {
      showToast({
        type: "error",
        title: _(S.inboxGuideFailed),
        description: err instanceof Error ? err.message : _(S.inboxRequestFailed),
      })
    }
  }

  const retry = async (item: SessionInboxItem) => {
    try {
      await props.sdk.client.session.inboxRetry({ sessionID, itemID: item.id }, { throwOnError: true })
    } catch (err) {
      showToast({
        type: "error",
        title: _(S.inboxRetryFailed),
        description: err instanceof Error ? err.message : _(S.inboxRequestFailed),
      })
    }
  }

  const guideAll = async () => {
    const targets = actionableItems()
    if (targets.length === 0) return
    try {
      for (const item of targets) {
        await props.sdk.client.session.inboxGuide({ sessionID, itemID: item.id }, { throwOnError: true })
      }
    } catch (err) {
      showToast({
        type: "error",
        title: _(S.inboxGuideAllFailed),
        description: err instanceof Error ? err.message : _(S.inboxRequestFailed),
      })
    }
  }

  const remove = (item: SessionInboxItem) => void change(item, "remove")
  const operationNotice = (item: SessionInboxItem) => (
    <Show when={operations()[item.id]}>
      {(operation) => (
        <div class="session-inbox-operation" role={operation().error ? "alert" : "status"}>
          <Show when={operation().pending}>{_(S.inboxOperationPending)}</Show>
          <Show when={operation().error}>
            <span>{_(operation().kind === "restore" ? S.inboxRestoreFailed : S.inboxRemoveFailed)}</span>
            <Button variant="secondary" size="small" onClick={() => void change(item, operation().kind)}>
              {_(operation().kind === "restore" ? S.inboxRetryRestore : S.inboxRetryRemove)}
            </Button>
            <details>
              <summary>{_(S.transitionErrorDetails)}</summary>
              <pre>{requestErrorMessage(operation().error, _(S.inboxRequestFailed))}</pre>
            </details>
          </Show>
        </div>
      )}
    </Show>
  )

  return (
    <div class="session-inbox-anchor">
      <Popover
        open={open()}
        onOpenChange={setOpen}
        placement="left-end"
        gutter={8}
        class="session-inbox-popover"
        title={
          <div class="session-inbox-title">
            <span class="session-inbox-title-main">{_(S.inboxTitle)}</span>
            <span class="session-inbox-title-subtitle">{titleDetail()}</span>
          </div>
        }
        triggerAs={(triggerProps) => (
          <button
            {...triggerProps}
            type="button"
            class="session-inbox-trigger statusbar-glass relative flex size-9 items-center justify-center rounded-full focus:outline-none"
            data-active={count() > 0}
            aria-label={_(S.inboxSessionAria)}
          >
            <Icon name={getSemanticIcon("session.inbox")} size="small" />
            <Show when={count() > 0}>
              <span class="session-inbox-badge">{Math.min(count(), 9)}</span>
            </Show>
          </button>
        )}
      >
        <Switch>
          <Match when={view().status === "loading"}>
            <div class="px-1 py-2 text-12-regular text-text-weak">{_(S.inboxLoading)}</div>
          </Match>
          <Match when={view().status === "empty"}>
            <div class="px-1 py-2 text-12-regular text-text-weak">{_(S.inboxEmpty)}</div>
          </Match>
          <Match when={true}>
            <div class="session-inbox-list">
              <Show when={props.freezeHint}>
                <div class="px-1 py-1 text-11-medium text-text-subtle">{_(S.inboxFrozen)}</div>
              </Show>
              <div class="session-inbox-queue-note">
                <span>{note()}</span>
                <Show when={!props.freezeHint && actionableItems().length > 1}>
                  <button type="button" class="session-inbox-send-all" onClick={guideAll}>
                    {_(S.inboxSendAll)}
                  </button>
                </Show>
              </div>
              <For each={items()}>
                {(item) => (
                  <div>
                    <InboxRow
                      item={item}
                      disabled={props.freezeHint || firstTaskLocked(item) || operations()[item.id]?.pending}
                      onGuide={guide}
                      onRemove={remove}
                      onRetry={retry}
                      i18n={i18n}
                    />
                    {operationNotice(item)}
                  </div>
                )}
              </For>
            </div>
          </Match>
        </Switch>
        <For
          each={Object.values(operations()).filter(
            (operation) =>
              operation.error &&
              !items().some((item) => item.id === operation.item.id) &&
              (removed.error || !removed()?.some((item) => item.id === operation.item.id)),
          )}
        >
          {(operation) => (
            <div>
              <span>{operation.item.summary.preview || operation.item.summary.title}</span>
              {operationNotice(operation.item)}
            </div>
          )}
        </For>
        <Show when={removed.loading}>
          <div role="status">{_(S.inboxLoading)}</div>
        </Show>
        <Show when={removed.error}>
          <div role="alert" class="session-inbox-operation">
            {_(S.inboxRemovedLoadFailed)}
            <Button size="small" onClick={() => void refetch()}>
              {_(S.inboxRetry)}
            </Button>
          </div>
        </Show>
        <Show when={!removed.error && removed()?.length}>
          <div class="session-inbox-removed-list">
            <h3>{_(S.inboxRemovedHeading)}</h3>
            <For each={removed()}>
              {(item) => (
                <div class="session-inbox-removed-item">
                  <details>
                    <summary>{item.summary.preview || item.summary.title}</summary>
                    <InboxDetail item={item} i18n={i18n} />
                  </details>
                  <Button
                    variant="secondary"
                    size="small"
                    disabled={operations()[item.id]?.pending}
                    onClick={() => void change(item, "restore")}
                  >
                    {_(S.inboxRestore)}
                  </Button>
                  {operationNotice(item)}
                </div>
              )}
            </For>
          </div>
        </Show>
      </Popover>
    </div>
  )
}
