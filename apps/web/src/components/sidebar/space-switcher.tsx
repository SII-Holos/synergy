import { createSignal, Show } from "solid-js"
import { DropdownMenu } from "@kobalte/core/dropdown-menu"
import { useLingui } from "@lingui/solid"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import "@ericsanchezok/synergy-ui/menu-field"
import { useOverlayLayer } from "@ericsanchezok/synergy-ui/context/overlay-layer"
import { PortalStyleOwner } from "@ericsanchezok/synergy-ui/context/ui-style"
import { BRAND_ASSETS, brandAssetPath } from "@/utils/brand-assets"
import { sidebar } from "@/locales/messages"
import { translateDescriptor } from "@/locales/translate"
import "./space-switcher.css"

function currentSpace() {
  return {
    name: { id: "app.sidebar.space.personal", message: "Personal space" },
    icon: brandAssetPath(BRAND_ASSETS.synergy.productIcon),
  }
}

export function SpaceSwitcher(props: {
  expanded: boolean
  onSettings: (section: "general" | "providers") => void
  onRepository: () => void
}) {
  const { _ } = useLingui()
  const overlayLayer = useOverlayLayer()
  let trigger: HTMLButtonElement | undefined
  let pendingAction: (() => void) | undefined
  const [open, setOpen] = createSignal(false)
  const label = () => _({ id: "app.sidebar.space.current", message: "Current space" })
  return (
    <div class="space-switcher">
      <DropdownMenu open={open()} onOpenChange={setOpen} modal={false} placement="top-start" gutter={8}>
        <Tooltip value={label()} placement="right" inactive={props.expanded}>
          <DropdownMenu.Trigger
            ref={trigger}
            class="space-switcher-trigger"
            classList={{ "space-switcher-trigger--collapsed": !props.expanded }}
            aria-label={label()}
          >
            <img src={currentSpace().icon} alt="" class="space-switcher-icon" />
            <Show when={props.expanded}>
              <span class="space-switcher-name">{translateDescriptor(currentSpace().name, { _ })}</span>
              <Icon name={getSemanticIcon(open() ? "navigation.collapse" : "navigation.expand")} size="small" />
            </Show>
          </DropdownMenu.Trigger>
        </Tooltip>
        <DropdownMenu.Portal mount={overlayLayer()}>
          <PortalStyleOwner>
            <DropdownMenu.Content
              class="menu-field-surface space-switcher-menu"
              aria-label={label()}
              onEscapeKeyDown={(event) => event.stopPropagation()}
              onCloseAutoFocus={(event) => {
                if (!pendingAction) return
                event.preventDefault()
                trigger?.focus()
                const action = pendingAction
                pendingAction = undefined
                action()
              }}
            >
              <DropdownMenu.Item
                class="menu-field-item"
                onSelect={() => {
                  pendingAction = () => props.onSettings("general")
                }}
              >
                <Icon name={getSemanticIcon("settings.general")} size="small" />
                <span>{_(sidebar.settings)}</span>
              </DropdownMenu.Item>
              <DropdownMenu.Item
                class="menu-field-item"
                onSelect={() => {
                  pendingAction = () => props.onSettings("providers")
                }}
              >
                <Icon name={getSemanticIcon("providers.main")} size="small" />
                <span>{_(sidebar.providers)}</span>
              </DropdownMenu.Item>
              <DropdownMenu.Item
                class="menu-field-item"
                onSelect={() => {
                  pendingAction = props.onRepository
                }}
              >
                <Icon name={getSemanticIcon("github.main")} size="small" />
                <span>{_(sidebar.repository)}</span>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </PortalStyleOwner>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </div>
  )
}
