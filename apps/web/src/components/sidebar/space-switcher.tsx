import { createSignal, createUniqueId, For, Show } from "solid-js"
import { DropdownMenu } from "@kobalte/core/dropdown-menu"
import { useLingui } from "@lingui/solid"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useOverlayLayer } from "@ericsanchezok/synergy-ui/context/overlay-layer"
import { PortalStyleOwner } from "@ericsanchezok/synergy-ui/context/ui-style"
import { BRAND_ASSETS, brandAssetPath } from "@/utils/brand-assets"
import { sidebar } from "@/locales/messages"
import { translateDescriptor } from "@/locales/translate"
import { useOptionalSpace } from "@/context/space"
import { organizationSpaceKey } from "@/organization/connections"
import { organizationSpaceMessages } from "@/organization/space-messages"
import "./space-switcher.css"

function currentSpace() {
  return {
    name: { id: "app.sidebar.space.personal", message: "Personal space" },
    icon: brandAssetPath(BRAND_ASSETS.synergy.productIcon),
  }
}

export function SpaceSwitcher(props: {
  expanded: boolean
  onNavigate?: () => void
  onSettings?: (section: "general" | "providers") => void
  onRepository: () => void
}) {
  const { _ } = useLingui()
  const space = useOptionalSpace()
  const current = () => space?.connection()
  const identityID = createUniqueId()
  const name = () =>
    current()?.name ??
    (current() ? new URL(current()!.issuer).hostname : translateDescriptor(currentSpace().name, { _ }))
  const overlayLayer = useOverlayLayer()
  let trigger: HTMLButtonElement | undefined
  let pendingAction: (() => void) | undefined
  const [open, setOpen] = createSignal(false)
  const label = () => _({ id: "app.sidebar.space.current", message: "Current space" })
  return (
    <div class="space-switcher" classList={{ "space-switcher--collapsed": !props.expanded }}>
      <DropdownMenu
        open={open()}
        onOpenChange={setOpen}
        modal={false}
        placement={props.expanded ? "top-start" : "right-end"}
        sameWidth={props.expanded}
        gutter={props.expanded ? 12 : 15}
      >
        <Tooltip
          value={current() ? `${name()} · ${current()!.account.displayName}` : name()}
          placement="right"
          inactive={props.expanded}
        >
          <DropdownMenu.Trigger
            ref={trigger}
            class="space-switcher-trigger"
            classList={{ "space-switcher-trigger--collapsed": !props.expanded }}
            aria-label={label()}
            aria-describedby={identityID}
          >
            <span id={identityID} class="sr-only">
              {name()}
              {current() ? ` · ${current()!.account.displayName}` : ""}
            </span>
            <Show when={current()} fallback={<img src={currentSpace().icon} alt="" class="space-switcher-icon" />}>
              <span class="space-switcher-avatar" aria-hidden="true">
                {Array.from(name())[0]?.toUpperCase()}
              </span>
            </Show>
            <Show when={props.expanded}>
              <span class="space-switcher-identity">
                <span class="space-switcher-name">{name()}</span>
                <Show when={current()}>
                  {(entry) => <span class="space-switcher-account">{entry().account.displayName}</span>}
                </Show>
              </span>
              <Icon name={getSemanticIcon("navigation.collapse")} size="small" class="space-switcher-chevron" />
            </Show>
          </DropdownMenu.Trigger>
        </Tooltip>
        <DropdownMenu.Portal mount={overlayLayer()}>
          <PortalStyleOwner>
            <DropdownMenu.Content
              class="space-switcher-menu"
              classList={{ "space-switcher-menu--collapsed": !props.expanded }}
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
              <Show when={space?.available}>
                <DropdownMenu.Item
                  class="space-switcher-menu-item"
                  onSelect={() => {
                    pendingAction = () => {
                      space!.personal()
                      props.onNavigate?.()
                    }
                  }}
                >
                  <img src={currentSpace().icon} alt="" class="space-switcher-menu-avatar" />
                  <span>{translateDescriptor(currentSpace().name, { _ })}</span>
                </DropdownMenu.Item>
                <For each={space?.connections}>
                  {(entry) => (
                    <DropdownMenu.Item
                      class="space-switcher-menu-item"
                      onSelect={() => {
                        pendingAction = () => {
                          space!.open(organizationSpaceKey(entry))
                          props.onNavigate?.()
                        }
                      }}
                    >
                      <span class="space-switcher-menu-avatar" aria-hidden="true">
                        {Array.from(entry.name ?? new URL(entry.issuer).hostname)[0]?.toUpperCase()}
                      </span>
                      <span class="space-switcher-identity">
                        <span>{entry.name ?? new URL(entry.issuer).hostname}</span>
                        <span class="space-switcher-account">{entry.account.displayName}</span>
                      </span>
                    </DropdownMenu.Item>
                  )}
                </For>
                <DropdownMenu.Item
                  class="space-switcher-menu-item"
                  onSelect={() => {
                    pendingAction = () => {
                      space!.add()
                      props.onNavigate?.()
                    }
                  }}
                >
                  <Icon name={getSemanticIcon("action.add")} size="small" />
                  <span>{_(organizationSpaceMessages.connect)}</span>
                </DropdownMenu.Item>
                <DropdownMenu.Separator class="space-switcher-separator" />
              </Show>
              <Show when={props.onSettings}>
                <DropdownMenu.Item
                  class="space-switcher-menu-item"
                  onSelect={() => {
                    pendingAction = () => props.onSettings?.("general")
                  }}
                >
                  <Icon name={getSemanticIcon("settings.general")} size="small" />
                  <span>{_(sidebar.settings)}</span>
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  class="space-switcher-menu-item"
                  onSelect={() => {
                    pendingAction = () => props.onSettings?.("providers")
                  }}
                >
                  <Icon name={getSemanticIcon("providers.main")} size="small" />
                  <span>{_(sidebar.providers)}</span>
                </DropdownMenu.Item>
              </Show>
              <DropdownMenu.Item
                class="space-switcher-menu-item"
                onSelect={() => {
                  pendingAction = props.onRepository
                }}
              >
                <Icon name={getSemanticIcon("github.main")} size="small" />
                <span>{_(sidebar.repository)}</span>
                <Icon name={getSemanticIcon("action.open")} size="small" class="space-switcher-menu-trailing" />
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </PortalStyleOwner>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </div>
  )
}
