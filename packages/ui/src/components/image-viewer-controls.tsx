import { ContextMenu, useContextMenuContext } from "@kobalte/core/context-menu"
import { DropdownMenu } from "@kobalte/core/dropdown-menu"
import { useMenuContext } from "@kobalte/core/menu"
import { createEffect, For, Show, type JSX } from "solid-js"
import { PortalStyleOwner } from "../context/ui-style"
import { Icon } from "./icon"
import { Tooltip } from "./tooltip"
import { getSemanticIcon, type SemanticIconTokenName } from "./semantic-icon"

export interface ImageViewerCommand {
  id: string
  label: () => string
  icon: SemanticIconTokenName
  text?: () => string
  visible?: () => boolean
  disabled?: () => boolean
  pressed?: () => boolean
  toolbar?: boolean
  run: () => void
}

function ImageViewerCanvas(props: { active: boolean; open: boolean; children: JSX.Element }) {
  const menu = useMenuContext()
  const context = useContextMenuContext()
  createEffect(() => {
    if (!props.open) menu.close()
  })
  return (
    <ContextMenu.Trigger
      as="div"
      disabled={!props.active}
      data-slot="image-viewer-canvas"
      onKeyDown={(event: KeyboardEvent) => {
        if (!props.active || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
        if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return
        event.preventDefault()
        event.stopPropagation()
        const target = event.target as HTMLElement
        const rect = target.getBoundingClientRect()
        context.setAnchorRect({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })
        menu.setTriggerRef(target)
        menu.open(true)
      }}
    >
      {props.children}
    </ContextMenu.Trigger>
  )
}

export function ImageViewerControls(props: {
  commands: ImageViewerCommand[]
  menuLabel: string
  zoom: string
  portal: HTMLElement | undefined
  active: boolean
  menuOpen: boolean
  onMenuOpen: (open: boolean) => void
  contextOpen: boolean
  onContextOpen: (open: boolean) => void
  children: JSX.Element
}) {
  const entries = (kind: "context" | "dropdown") => {
    const Menu = kind === "context" ? ContextMenu : DropdownMenu
    return (
      <For each={props.commands}>
        {(command) => {
          const Item = command.pressed ? Menu.CheckboxItem : Menu.Item
          return (
            <Show when={command.visible?.() ?? true}>
              <Item checked={command.pressed?.()} closeOnSelect disabled={command.disabled?.()} onSelect={command.run}>
                <Icon name={getSemanticIcon(command.icon)} size="small" />
                <span>{command.label()}</span>
                <Show when={command.pressed?.()}>
                  <Icon name={getSemanticIcon("state.success")} size="small" />
                </Show>
              </Item>
            </Show>
          )
        }}
      </For>
    )
  }
  const menuEvents = {
    onEscapeKeyDown: (event: KeyboardEvent) => event.stopPropagation(),
    onCloseAutoFocus: (event: Event) => {
      if (!props.active) event.preventDefault()
    },
  }
  return (
    <>
      <div data-slot="image-viewer-toolbar" role="group" aria-label={props.menuLabel}>
        <For each={props.commands.filter((command) => command.toolbar)}>
          {(command) => (
            <Show when={command.visible?.() ?? true}>
              <Tooltip value={command.label()} inactive={!props.active}>
                <button
                  type="button"
                  data-component="icon-button"
                  data-variant="ghost"
                  data-viewer-command={command.id}
                  aria-label={command.label()}
                  aria-pressed={command.pressed?.()}
                  disabled={command.disabled?.()}
                  onClick={command.run}
                >
                  <Show when={command.text} fallback={<Icon name={getSemanticIcon(command.icon)} size="small" />}>
                    {command.text?.()}
                  </Show>
                </button>
              </Tooltip>
              <Show when={command.id === "zoomOut"}>
                <output data-slot="image-viewer-scale">{props.zoom}</output>
              </Show>
            </Show>
          )}
        </For>
        <DropdownMenu open={props.active && props.menuOpen} onOpenChange={props.onMenuOpen} gutter={6} modal={false}>
          <DropdownMenu.Trigger data-component="icon-button" data-variant="ghost" aria-label={props.menuLabel}>
            <Icon name={getSemanticIcon("action.more")} size="small" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal mount={props.portal}>
            <PortalStyleOwner>
              <DropdownMenu.Content data-component="image-viewer-menu" aria-label={props.menuLabel} {...menuEvents}>
                {entries("dropdown")}
              </DropdownMenu.Content>
            </PortalStyleOwner>
          </DropdownMenu.Portal>
        </DropdownMenu>
      </div>
      <ContextMenu onOpenChange={props.onContextOpen} modal={false}>
        <ImageViewerCanvas active={props.active} open={props.active && props.contextOpen}>
          {props.children}
        </ImageViewerCanvas>
        <ContextMenu.Portal mount={props.portal}>
          <PortalStyleOwner>
            <ContextMenu.Content data-component="image-viewer-menu" aria-label={props.menuLabel} {...menuEvents}>
              {entries("context")}
            </ContextMenu.Content>
          </PortalStyleOwner>
        </ContextMenu.Portal>
      </ContextMenu>
    </>
  )
}
