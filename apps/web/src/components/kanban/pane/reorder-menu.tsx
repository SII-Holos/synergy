import { DropdownMenu } from "@kobalte/core/dropdown-menu"
import { createSignal, For } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import "@ericsanchezok/synergy-ui/menu-field"

export type KanbanReorderAction = { id: string; label: string; disabled: boolean; target?: string }

export function KanbanReorderMenu(props: {
  actions: readonly KanbanReorderAction[]
  onReorder?: (target: string) => void
}) {
  const { _ } = useLingui()
  const label = () => _({ id: "app.kanban.paneActions", message: "Session panel actions" })
  const [open, setOpen] = createSignal(false)
  let content: HTMLDivElement | undefined
  let focusEdge: "first" | "last" | undefined

  function openFromKeyboard(event: KeyboardEvent) {
    if (!["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) return
    // Kobalte utils 0.9.1 repeats the same scroll ancestor beneath an overflow-hidden root.
    // https://github.com/kobaltedev/kobalte/blob/main/packages/utils/src/scroll-into-view.ts
    event.preventDefault()
    event.stopPropagation()
    focusEdge = event.key === "ArrowUp" ? "last" : "first"
    setOpen(true)
  }

  return (
    <DropdownMenu modal={false} open={open()} onOpenChange={setOpen}>
      <DropdownMenu.Trigger
        as="button"
        type="button"
        class="kanban-pane-action"
        aria-label={label()}
        on:keydown={openFromKeyboard}
      >
        <Icon name={getSemanticIcon("action.more")} size="small" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          ref={content}
          class="menu-field-surface"
          aria-label={label()}
          onOpenAutoFocus={(event) => {
            if (!focusEdge) return
            event.preventDefault()
            const edge = focusEdge
            focusEdge = undefined
            setTimeout(() => {
              if (!open() || !content?.isConnected) return
              const items = content.querySelectorAll<HTMLElement>('[role="menuitem"]:not([data-disabled])')
              const item = edge === "last" ? items[items.length - 1] : items[0]
              const target = item ?? content
              target.focus({ preventScroll: true })
            }, 0)
          }}
        >
          <For each={props.actions}>
            {(action) => (
              <DropdownMenu.Item
                class="menu-field-item"
                disabled={action.disabled || !action.target}
                onSelect={() => {
                  if (action.target) props.onReorder?.(action.target)
                }}
              >
                {action.label}
              </DropdownMenu.Item>
            )}
          </For>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}
