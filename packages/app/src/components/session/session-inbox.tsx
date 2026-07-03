import { createMemo, For, Match, Show, Switch } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Markdown } from "@ericsanchezok/synergy-ui/markdown"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import type { SessionInboxItem } from "@ericsanchezok/synergy-sdk/client"
import type { useSDK } from "@/context/sdk"
import type { useSync } from "@/context/sync"
import { deriveSessionInboxView, isInboxItemInteractive } from "./session-inbox-utils"
import "./session-inbox.css"

type SessionInboxProps = {
  sessionID: string
  sync: ReturnType<typeof useSync>
  sdk: ReturnType<typeof useSDK>
}

const labelByKind: Record<SessionInboxItem["kind"], string> = {
  queued_user: "Queued by you",
  guiding: "Guiding current run",
  agent_update: "Agent updates",
}

const iconByKind: Record<SessionInboxItem["kind"], "message-square" | "zap" | "megaphone"> = {
  queued_user: "message-square",
  guiding: "zap",
  agent_update: "megaphone",
}

function timingLabel(item: SessionInboxItem) {
  return item.deliveryTarget === "next_model_call" ? "Next call" : "After turn"
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
      <div class="text-12-medium text-text-strong">{labelByKind[props.item.kind]}</div>
      <Markdown
        text={detailText(props.item)}
        cacheKey={`session-inbox-detail-${props.item.id}`}
        class="session-inbox-detail-markdown"
      />
      <div class="mt-2 flex items-center gap-1.5 text-10-regular text-text-weak">
        <span>{props.item.source.label ?? props.item.source.type}</span>
        <span>·</span>
        <span>{timingLabel(props.item)}</span>
      </div>
    </div>
  )
}

function InboxRow(props: {
  item: SessionInboxItem
  onGuide: (item: SessionInboxItem) => void
  onRemove: (item: SessionInboxItem) => void
}) {
  const canInteract = () => isInboxItemInteractive(props.item)
  return (
    <Tooltip placement="left" value={<InboxDetail item={props.item} />}>
      <div class="session-inbox-row group" data-kind={props.item.kind} data-interactive={canInteract()}>
        <Icon
          name={iconByKind[props.item.kind]}
          size="small"
          classList={{
            "text-icon-weak": props.item.kind !== "guiding",
            "text-icon-base": props.item.kind === "guiding",
          }}
        />
        <div class="min-w-0">
          <div class="flex min-w-0 items-center gap-1.5">
            <span class="truncate text-12-medium text-text-base">{labelByKind[props.item.kind]}</span>
            <span class="shrink-0 text-10-regular text-text-weaker">{timingLabel(props.item)}</span>
          </div>
          <div class="mt-0.5 truncate text-12-regular text-text-weak">
            {props.item.summary.preview || props.item.summary.title}
          </div>
        </div>
        <div class="session-inbox-actions">
          <Show when={canInteract()}>
            <button
              type="button"
              class="session-inbox-action"
              data-primary="true"
              aria-label="Guide current run"
              onClick={(event) => {
                event.stopPropagation()
                props.onGuide(props.item)
              }}
            >
              <Icon name="zap" size="small" />
            </button>
            <button
              type="button"
              class="session-inbox-action session-inbox-action-secondary"
              aria-label="Remove queued message"
              onClick={(event) => {
                event.stopPropagation()
                props.onRemove(props.item)
              }}
            >
              <Icon name="x" size="small" />
            </button>
          </Show>
        </div>
      </div>
    </Tooltip>
  )
}

export function SessionInbox(props: SessionInboxProps) {
  const view = createMemo(() => deriveSessionInboxView(props.sync.data.inbox[props.sessionID]))
  const items = createMemo(() => view().items)
  const count = createMemo(() => view().count)

  const guide = async (item: SessionInboxItem) => {
    try {
      await props.sdk.client.session.inboxGuide({ sessionID: props.sessionID, itemID: item.id })
    } catch (err) {
      showToast({
        type: "error",
        title: "Failed to guide run",
        description: err instanceof Error ? err.message : "Request failed",
      })
    }
  }

  const remove = async (item: SessionInboxItem) => {
    try {
      await props.sdk.client.session.inboxRemove({ sessionID: props.sessionID, itemID: item.id })
    } catch (err) {
      showToast({
        type: "error",
        title: "Failed to remove message",
        description: err instanceof Error ? err.message : "Request failed",
      })
    }
  }

  return (
    <div class="session-inbox-anchor">
      <Popover
        placement="left-end"
        gutter={8}
        class="session-inbox-popover"
        title={
          <div class="flex items-center gap-2">
            <Icon name="mail" size="small" class="text-icon-weak" />
            <span>Inbox</span>
          </div>
        }
        trigger={
          <button
            type="button"
            class="session-inbox-trigger statusbar-glass relative flex size-9 items-center justify-center rounded-full focus:outline-none"
            data-active={count() > 0}
            aria-label="Session inbox"
          >
            <Icon name="mail" size="small" />
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
              <For each={items()}>{(item) => <InboxRow item={item} onGuide={guide} onRemove={remove} />}</For>
            </div>
          </Match>
        </Switch>
      </Popover>
    </div>
  )
}
