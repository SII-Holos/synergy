import { useOverlayLayer } from "../context/overlay-layer"
import { For, Show } from "solid-js"
import { DropdownMenu } from "@kobalte/core/dropdown-menu"
import type { PluginUIComponents, StateProps } from "@ericsanchezok/synergy-plugin/components"
import { Button } from "./button"
import { TextField } from "./text-field"
import { MenuField } from "./menu-field"
import { Tabs } from "./tabs"
import { Dialog } from "./dialog"
import { Popover } from "./popover"
import { Tooltip } from "./tooltip"
import { SettingRow } from "./setting-row"
import { Spinner } from "./spinner"
import { Icon } from "./icon"
import { SemanticIconToken, type SemanticIconTokenName } from "./semantic-icon"
import { PortalStyleOwner } from "../context/ui-style"
import "./plugin-components.css"

function State(props: StateProps & { kind: "loading" | "empty" | "error" }) {
  return (
    <section data-component="plugin-state" role={props.kind === "error" ? "alert" : "status"}>
      <Show when={props.kind === "loading"}>
        <Spinner />
      </Show>
      <strong>{props.title}</strong>
      <Show when={props.description}>
        <p>{props.description}</p>
      </Show>
      {props.action}
    </section>
  )
}

export const pluginComponents: PluginUIComponents = {
  Button,
  Input: (props) => <TextField {...props} validationState={props.error ? "invalid" : "valid"} />,
  Select: (props) => (
    <MenuField
      value={props.value}
      options={[...props.options]}
      onChange={props.onChange}
      ariaLabel={props.label}
      disabled={props.disabled}
    />
  ),
  Tabs: (props) => (
    <Tabs value={props.value} onChange={props.onChange}>
      <Tabs.List aria-label={props.label}>
        <For each={props.items}>
          {(item) => (
            <Tabs.Trigger value={item.id} disabled={item.disabled}>
              {item.label}
            </Tabs.Trigger>
          )}
        </For>
      </Tabs.List>
      <For each={props.items}>{(item) => <Tabs.Content value={item.id}>{item.content()}</Tabs.Content>}</For>
    </Tabs>
  ),
  Menu: (props) => {
    const layer = useOverlayLayer()
    return (
      <DropdownMenu gutter={4}>
        <DropdownMenu.Trigger as={Button}>{props.label}</DropdownMenu.Trigger>
        <DropdownMenu.Portal mount={layer()}>
          <PortalStyleOwner>
            <DropdownMenu.Content data-component="plugin-menu" aria-label={props.label}>
              <For each={props.items}>
                {(item) => (
                  <DropdownMenu.Item disabled={item.disabled} onSelect={item.select}>
                    {item.label}
                  </DropdownMenu.Item>
                )}
              </For>
            </DropdownMenu.Content>
          </PortalStyleOwner>
        </DropdownMenu.Portal>
      </DropdownMenu>
    )
  },
  Dialog,
  Popover,
  Tooltip,
  FormField: (props) => (
    <div data-component="plugin-form-field">
      <label for={props.for}>{props.label}</label>
      {props.children({
        id: props.for,
        "aria-describedby":
          [props.description && `${props.for}-description`, props.error && `${props.for}-error`]
            .filter(Boolean)
            .join(" ") || undefined,
        "aria-invalid": !!props.error,
      })}
      <Show when={props.description}>
        <p id={`${props.for}-description`}>{props.description}</p>
      </Show>
      <Show when={props.error}>
        <p id={`${props.for}-error`} role="alert">
          {props.error}
        </p>
      </Show>
    </div>
  ),
  SettingRow,
  Loading: (props) => <State {...props} kind="loading" />,
  EmptyState: (props) => <State {...props} kind="empty" />,
  ErrorState: (props) => <State {...props} kind="error" />,
  Icon: (props) => {
    if (!Object.hasOwn(SemanticIconToken, props.token)) throw new Error(`Unknown semantic icon ${props.token}`)
    return (
      <span
        role={props.label ? "img" : undefined}
        aria-label={props.label}
        aria-hidden={props.label ? undefined : true}
      >
        <Icon name={SemanticIconToken[props.token as SemanticIconTokenName]} size={props.size} />
      </span>
    )
  },
  HostView: (props) => props.shell.render(props.view),
}
