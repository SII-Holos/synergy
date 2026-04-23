import { createSignal, Show } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { relativeTime } from "@/utils/time"
import type { Session } from "@ericsanchezok/synergy-sdk/client"

export interface SessionRowProps {
  session: Session
  isActive: boolean
  isWorking: boolean
  hasPermission: boolean
  hasError: boolean
  hasNotification: boolean
  notificationCount: number
  even?: boolean
  onSelect: () => void
  onTogglePin: () => void
  onArchive: () => void
  onRename: (title: string) => void
}

function statusBarColor(props: SessionRowProps) {
  if (props.isWorking) return "bg-icon-success-base"
  if (props.hasPermission) return "bg-surface-warning-strong"
  if (props.hasError) return "bg-text-diff-delete-base"
  if (props.hasNotification) return "bg-text-interactive-base"
  return "bg-transparent"
}

function StatusDot(props: SessionRowProps) {
  const isPinned = () => props.session.pinned && props.session.pinned > 0

  return (
    <div class="w-5 shrink-0 flex items-center justify-center">
      <Show when={props.isWorking}>
        <Spinner class="size-3" />
      </Show>
      <Show when={!props.isWorking && props.hasPermission}>
        <div class="size-1.5 rounded-full bg-surface-warning-strong" />
      </Show>
      <Show when={!props.isWorking && !props.hasPermission && props.hasError}>
        <div class="size-1.5 rounded-full bg-text-diff-delete-base" />
      </Show>
      <Show when={!props.isWorking && !props.hasPermission && !props.hasError && props.hasNotification}>
        <div class="size-1.5 rounded-full bg-text-interactive-base" />
      </Show>
      <Show when={!props.isWorking && !props.hasPermission && !props.hasError && !props.hasNotification && isPinned()}>
        <Icon name="pin" size="small" class="text-icon-weak" />
      </Show>
    </div>
  )
}

function ActionMenu(props: {
  isPinned: boolean
  onTogglePin: () => void
  onRename: () => void
  onArchive: () => void
}) {
  const [open, setOpen] = createSignal(false)

  function handleItemClick(action: () => void) {
    action()
    setOpen(false)
  }

  return (
    <div class="relative" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        class="flex items-center justify-center size-6 rounded-md text-icon-weak hover:text-text-base hover:bg-surface-raised-base-hover transition-colors cursor-pointer"
        onClick={() => setOpen(!open())}
      >
        <Icon name="ellipsis" size="small" />
      </button>
      <Show when={open()}>
        <div
          class="absolute right-0 top-full mt-1 z-50 min-w-[140px] py-1 rounded-lg bg-surface-raised-base border border-border-base shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            class="w-full flex items-center gap-2 px-3 py-1.5 text-12-medium text-text-base hover:bg-surface-raised-base-hover transition-colors cursor-pointer text-left"
            onClick={() => handleItemClick(props.onTogglePin)}
          >
            <Icon name="pin" size="small" class="text-icon-weak" />
            {props.isPinned ? "Unpin" : "Pin"}
          </button>
          <button
            type="button"
            class="w-full flex items-center gap-2 px-3 py-1.5 text-12-medium text-text-base hover:bg-surface-raised-base-hover transition-colors cursor-pointer text-left"
            onClick={() => handleItemClick(props.onRename)}
          >
            <Icon name="pencil" size="small" class="text-icon-weak" />
            Rename
          </button>
          <button
            type="button"
            class="w-full flex items-center gap-2 px-3 py-1.5 text-12-medium text-text-diff-delete-base hover:bg-text-diff-delete-base/10 transition-colors cursor-pointer text-left"
            onClick={() => handleItemClick(props.onArchive)}
          >
            <Icon name="archive" size="small" />
            Archive
          </button>
        </div>
      </Show>
    </div>
  )
}

export function SessionRow(props: SessionRowProps) {
  const isPinned = () => props.session.pinned && props.session.pinned > 0
  const updatedAt = () => props.session.time.updated ?? props.session.time.created
  const lastExchangePreview = () => props.session.lastExchange?.assistant ?? props.session.lastExchange?.user

  const [renaming, setRenaming] = createSignal(false)
  const [renameValue, setRenameValue] = createSignal("")

  function startRename() {
    setRenameValue(props.session.title || "")
    setRenaming(true)
  }

  function commitRename() {
    const value = renameValue().trim()
    setRenaming(false)
    if (value && value !== props.session.title) {
      props.onRename(value)
    }
  }

  function cancelRename() {
    setRenaming(false)
  }

  function handleDragStart(e: DragEvent) {
    if (!e.dataTransfer) return
    const title = props.session.title || "New session"
    const payload = JSON.stringify({
      id: props.session.id,
      directory: props.session.scope.directory,
      title,
      updatedAt: props.session.time.updated ?? props.session.time.created,
    })
    e.dataTransfer.effectAllowed = "copy"
    e.dataTransfer.setData("application/x-synergy-session", payload)
    e.dataTransfer.setData("text/plain", title)
    const dragImage = document.createElement("div")
    dragImage.className =
      "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface-raised-base text-12-medium text-text-base shadow-lg border border-border-base"
    dragImage.style.position = "absolute"
    dragImage.style.top = "-1000px"
    dragImage.textContent = title
    document.body.appendChild(dragImage)
    e.dataTransfer.setDragImage(dragImage, 0, 16)
    setTimeout(() => document.body.removeChild(dragImage), 0)
  }

  return (
    <div
      class="group/row relative flex cursor-pointer transition-colors duration-100 hover:bg-surface-raised-base-hover"
      classList={{
        "bg-surface-interactive-base/8": props.isActive,
        "bg-surface-raised-base/50": !props.isActive && !!props.even,
      }}
      onClick={props.onSelect}
      draggable={true}
      onDragStart={handleDragStart}
    >
      {/* Left status bar */}
      <div class={`w-[2.5px] shrink-0 self-stretch ${statusBarColor(props)}`} />

      {/* Main content */}
      <div class="flex items-center gap-3 px-3 py-2.5 flex-1 min-w-0">
        <StatusDot {...props} />

        {/* Text block */}
        <div class="flex-1 min-w-0">
          <Show
            when={!renaming()}
            fallback={
              <input
                ref={(el) => requestAnimationFrame(() => el.focus())}
                type="text"
                class="text-13-medium bg-transparent border-b border-border-interactive-base outline-none flex-1 min-w-0 w-full"
                value={renameValue()}
                onInput={(e) => setRenameValue(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename()
                  if (e.key === "Escape") cancelRename()
                }}
                onBlur={commitRename}
                onClick={(e) => e.stopPropagation()}
              />
            }
          >
            <div
              classList={{
                "text-13-medium line-clamp-1": true,
                "text-text-strong": props.isActive,
                "text-text-base": !props.isActive,
              }}
            >
              {props.session.title || "New session"}
            </div>
            <Show when={lastExchangePreview()}>
              <div class="text-11-regular text-text-weak line-clamp-1 mt-0.5">{lastExchangePreview()}</div>
            </Show>
          </Show>
        </div>

        {/* Time */}
        <span class="text-11-regular text-text-weak shrink-0">{relativeTime(updatedAt())}</span>

        {/* Action menu (hover-reveal) */}
        <div class="shrink-0 opacity-0 group-hover/row:opacity-100 transition-opacity">
          <ActionMenu
            isPinned={!!isPinned()}
            onTogglePin={props.onTogglePin}
            onRename={startRename}
            onArchive={props.onArchive}
          />
        </div>
      </div>
    </div>
  )
}
