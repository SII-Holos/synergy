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
import { deriveSessionInboxView, isInboxItemInteractive } from "./session-inbox-utils"
import "./session-inbox.css"

type SessionInboxProps = {
  sessionID: string
  sync: ReturnType<typeof useSync>
  sdk: ReturnType<typeof useSDK>
  freezeHint?: boolean
}

function labelByMode(item: SessionInboxItem): string {
  if (item.mode === "task") return "Queued by you"
  if (item.mode === "steer") return "Guiding current run"
  if (item.mode === "context") return "Context update"
  return "Update"
}

function timingLabel(item: SessionInboxItem): string {
  if (item.mode === "task") return "After turn"
  if (item.mode === "steer") return "Next call"
  return "Context"
}

function deliveryDescription(item: SessionInboxItem) {
  if (item.mode === "task") return "Sends after this turn; multiple queued items share one reply cycle."
  if (item.mode === "steer") return "Joins the current run before its next model request."
  return "Joined to the ongoing model call as context."
}

function itemCountLabel(count: number) {
  return `${count} ${count === 1 ? "item" : "items"} waiting for your attention`
}

function queueNote(items: SessionInboxItem[]) {
  const steers = items.filter((item) => item.mode === "steer").length
  const tasks = items.filter((item) => item.mode === "task").length
  const contexts = items.filter((item) => item.mode === "context").length

  if (steers > 0 && tasks > 0) return `${steers} next call · ${tasks} after turn`
  if (steers > 1) return `${steers} items join the next model call`
  if (steers === 1) return "Joins the current run's next model call"
  if (tasks > 1) return `${tasks} items send together in one reply`
  if (tasks === 1) return "Sends automatically after this turn"
  if (contexts > 1) return `${contexts} context updates waiting`
  if (contexts === 1) return "Context update waiting"
  return "Inbox clear"
}

function detailText(item: SessionInboxItem) {
  const lines: string[] = []
  if (item.detail?.text) lines.push(item.detail.text)
  if (item.detail?.attachments?.length) lines.push(item.detail.attachments.join("\n"))
  return lines.join("\n\n").trim() || item.summary.preview || item.summary.title
}

function InboxDetail(props: { item: SessionInboxItem }) {
  return (
    <div class="session-inbox-detail">
      <div class="text-12-medium text-text-strong">{labelByMode(props.item)}</div>
      <Markdown
        text={detailText(props.item)}
        cacheKey={`session-inbox-detail-${props.item.id}`}
        class="session-inbox-detail-markdown"
      />
      <div class="session-inbox-detail-meta">
        <span>{props.item.source.label ?? props.item.source.type}</span>
        <span>·</span>
        <span>{deliveryDescription(props.item)}</span>
      </div>
    </div>
  )
}

function InboxRow(props: {
  item: SessionInboxItem
  disabled?: boolean
  onGuide: (item: SessionInboxItem) => void
  onRemove: (item: SessionInboxItem) => void
}) {
  const [menuOpen, setMenuOpen] = createSignal(false)
  const canInteract = () => !props.disabled && isInboxItemInteractive(props.item)
  const preview = () => props.item.summary.preview || props.item.summary.title
  const guideLabel = () => (props.item.mode === "steer" ? "Queue" : "Send now")
  const guideTitle = () =>
    props.item.mode === "steer"
      ? "Move this message back to the queued task list."
      : "Add this message to the current run's next model call."

  const remove = () => {
    setMenuOpen(false)
    props.onRemove(props.item)
  }

  return (
    <div class="session-inbox-row" data-mode={props.item.mode} data-interactive={canInteract()}>
      <Tooltip placement="left" class="session-inbox-row-tooltip" value={<InboxDetail item={props.item} />}>
        <div class="session-inbox-row-main">
          <div class="session-inbox-row-meta">
            <span class="session-inbox-row-label">{labelByMode(props.item)}</span>
            <span class="session-inbox-row-status" data-mode={props.item.mode}>
              {timingLabel(props.item)}
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
                aria-label="Queued message actions"
                aria-expanded={menuOpen()}
              >
                <Icon name={getSemanticIcon("action.more")} size="small" />
              </button>
            }
          >
            <div class="session-inbox-menu-list">
              <button type="button" class="session-inbox-menu-item" onClick={remove}>
                Delete
              </button>
            </div>
          </Popover>
        </div>
      </Show>
    </div>
  )
}

export function SessionInbox(props: SessionInboxProps) {
  const view = createMemo(() => deriveSessionInboxView(props.sync.data.inbox[props.sessionID]))
  const items = createMemo(() => view().items)
  const count = createMemo(() => view().count)
  const actionableItems = createMemo(() => items().filter(isInboxItemInteractive))
  const titleDetail = createMemo(() => {
    if (view().status === "loading") return "Checking for queued messages"
    if (count() === 0) return "Inbox clear"
    return itemCountLabel(count())
  })
  const note = createMemo(() => queueNote(items()))

  const guide = async (item: SessionInboxItem) => {
    try {
      await props.sdk.client.session.inboxGuide({ sessionID: props.sessionID, itemID: item.id })
    } catch (err) {
      showToast({
        type: "error",
        title: "Failed to send message now",
        description: err instanceof Error ? err.message : "Request failed",
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
        title: "Failed to send queued messages now",
        description: err instanceof Error ? err.message : "Request failed",
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
      title: "Removed queued message",
      description: "The message has been removed from the inbox. Restoring it will add it to the queue tail.",
      actions: [
        {
          label: "Restore",
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
            <span class="session-inbox-title-main">Inbox</span>
            <span class="session-inbox-title-subtitle">{titleDetail()}</span>
          </div>
        }
        trigger={
          <button
            type="button"
            class="session-inbox-trigger statusbar-glass relative flex size-9 items-center justify-center rounded-full focus:outline-none"
            data-active={count() > 0}
            aria-label="Session inbox"
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
            <div class="px-1 py-2 text-12-regular text-text-weak">Loading inbox…</div>
          </Match>
          <Match when={view().status === "empty"}>
            <div class="px-1 py-2 text-12-regular text-text-weak">Inbox clear</div>
          </Match>
          <Match when={true}>
            <div class="session-inbox-list">
              <Show when={props.freezeHint}>
                <div class="px-1 py-1 text-11-medium text-text-subtle">Inbox frozen while rewinding</div>
              </Show>
              <div class="session-inbox-queue-note">
                <span>{note()}</span>
                <Show when={!props.freezeHint && actionableItems().length > 1}>
                  <button type="button" class="session-inbox-send-all" onClick={guideAll}>
                    Send all now
                  </button>
                </Show>
              </div>
              <For each={items()}>
                {(item) => <InboxRow item={item} disabled={props.freezeHint} onGuide={guide} onRemove={remove} />}
              </For>
            </div>
          </Match>
        </Switch>
      </Popover>
    </div>
  )
}
