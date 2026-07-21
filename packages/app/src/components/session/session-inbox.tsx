import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Markdown } from "@ericsanchezok/synergy-ui/markdown"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { SessionInboxItem } from "@ericsanchezok/synergy-sdk/client"
import type { useSDK } from "@/context/sdk"
import type { useSync } from "@/context/sync"
import { useLocale } from "@/context/locale"
import { deriveSessionInboxView, isInboxItemInteractive } from "./session-inbox-utils"
import { S } from "./session-i18n"
import "./session-inbox.css"

type SessionInboxProps = {
  sessionID: string
  sync: ReturnType<typeof useSync>
  sdk: ReturnType<typeof useSDK>
  freezeHint?: boolean
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
  i18n: ReturnType<typeof useLocale>["i18n"]
}) {
  const _ = (d: { id: string; message: string }) => props.i18n._(d)
  const [menuOpen, setMenuOpen] = createSignal(false)
  const canInteract = () => !props.disabled && isInboxItemInteractive(props.item)
  const preview = () => props.item.summary.preview || props.item.summary.title
  const guideLabel = () => (props.item.mode === "steer" ? _(S.inboxGuideQueue) : _(S.inboxGuideSendNow))
  const guideTitle = () => (props.item.mode === "steer" ? _(S.inboxGuideQueueTip) : _(S.inboxGuideSendNowTip))

  const remove = () => {
    setMenuOpen(false)
    props.onRemove(props.item)
  }

  const timingLabel = () => {
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
    <div class="session-inbox-row" data-mode={props.item.mode} data-interactive={canInteract()}>
      <Tooltip
        placement="left"
        class="session-inbox-row-tooltip"
        value={<InboxDetail item={props.item} i18n={props.i18n} />}
      >
        <div class="session-inbox-row-main">
          <div class="session-inbox-row-meta">
            <span class="session-inbox-row-label">{modeLabel()}</span>
            <span class="session-inbox-row-status" data-mode={props.item.mode}>
              {timingLabel()}
            </span>
          </div>
          <div class="session-inbox-row-preview">{preview()}</div>
        </div>
      </Tooltip>
      <Show when={canInteract()}>
        <div class="session-inbox-actions">
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
          <Popover
            open={menuOpen()}
            onOpenChange={setMenuOpen}
            placement="bottom-end"
            gutter={6}
            class="session-inbox-menu-popover"
            trigger={
              <button
                type="button"
                class="session-inbox-more"
                aria-label={_(S.inboxDetailAria)}
                aria-expanded={menuOpen()}
              >
                <Icon name={getSemanticIcon("action.more")} size="small" />
              </button>
            }
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
  const { i18n } = useLocale()
  const _ = (d: { id: string; message: string }) => i18n._(d)
  const view = createMemo(() => deriveSessionInboxView(props.sync.data.inbox[props.sessionID]))
  const items = createMemo(() => view().items)
  const count = createMemo(() => view().count)
  const actionableItems = createMemo(() => items().filter(isInboxItemInteractive))

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
      await props.sdk.client.session.inboxGuide({ sessionID: props.sessionID, itemID: item.id })
    } catch (err) {
      showToast({
        type: "error",
        title: _(S.inboxGuideFailed),
        description: err instanceof Error ? err.message : _(S.inboxRequestFailed),
      })
    }
  }

  const guideAll = async () => {
    const targets = actionableItems()
    if (targets.length === 0) return
    try {
      for (const item of targets) {
        await props.sdk.client.session.inboxGuide({ sessionID: props.sessionID, itemID: item.id })
      }
    } catch (err) {
      showToast({
        type: "error",
        title: _(S.inboxGuideAllFailed),
        description: err instanceof Error ? err.message : _(S.inboxRequestFailed),
      })
    }
  }

  const restoreItem = async (item: SessionInboxItem) => {
    if (!item.message?.parts?.length) return
    await props.sdk.client.session.input({
      sessionID: props.sessionID,
      agent: item.message.agent,
      model: item.message.model,
      parts: item.message.parts,
    })
  }

  const remove = async (item: SessionInboxItem) => {
    await props.sdk.client.session.inboxRemove({ sessionID: props.sessionID, itemID: item.id })
    showToast({
      type: "info",
      title: _(S.inboxRemoved),
      description: _(S.inboxRemovedDesc),
      actions: [
        {
          label: _(S.inboxRestore),
          onClick: () => {
            void restoreItem(item).catch(() => {})
          },
        },
      ],
    })
  }

  return (
    <div class="session-inbox-anchor">
      <Popover
        placement="left-end"
        gutter={8}
        class="session-inbox-popover"
        title={
          <div class="session-inbox-title">
            <span class="session-inbox-title-main">{_(S.inboxTitle)}</span>
            <span class="session-inbox-title-subtitle">{titleDetail()}</span>
          </div>
        }
        trigger={
          <button
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
        }
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
                  <InboxRow item={item} disabled={props.freezeHint} onGuide={guide} onRemove={remove} i18n={i18n} />
                )}
              </For>
            </div>
          </Match>
        </Switch>
      </Popover>
    </div>
  )
}
