import type { SemanticIconTokenName } from "./icons.js"
import type { Component, JSX } from "solid-js"
import type { PluginHostViewId, PluginShellService } from "./ui.js"

export const PLUGIN_UI_RUNTIME_KEY = "__SYNERGY_PLUGIN_UI_RUNTIME__"
export type ButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
  size?: "small" | "normal" | "large"
  variant?: "primary" | "secondary" | "ghost"
}
export interface InputProps {
  value: string
  onChange(value: string): void
  label: string
  description?: string
  error?: string
  placeholder?: string
  disabled?: boolean
  readOnly?: boolean
  required?: boolean
  multiline?: boolean
  class?: string
}
export interface SelectProps {
  value: string
  onChange(value: string): void
  label: string
  options: ReadonlyArray<{ value: string; label: string; disabled?: boolean }>
  disabled?: boolean
}
export interface TabsProps {
  value: string
  onChange(value: string): void
  label: string
  items: ReadonlyArray<{ id: string; label: string; disabled?: boolean; content(): JSX.Element }>
}
export interface MenuProps {
  label: string
  items: ReadonlyArray<{ id: string; label: string; disabled?: boolean; select(): void }>
}
export interface DialogProps {
  title: string
  description?: string
  dismissible?: boolean
  size?: "compact" | "form" | "list" | "wide" | "command" | "content"
  children?: JSX.Element
}
export interface PopoverProps {
  trigger: Component<JSX.ButtonHTMLAttributes<HTMLButtonElement>>
  title: string
  description?: string
  children?: JSX.Element
}
export interface TooltipProps {
  value: string
  children?: JSX.Element
}
export interface FormFieldProps {
  label: string
  for: string
  description?: string
  error?: string
  children(control: { id: string; "aria-describedby": string | undefined; "aria-invalid": boolean }): JSX.Element
}
export interface SettingRowProps {
  title: string
  description: string
  trailing: JSX.Element
  leading?: JSX.Element
  stateLabel?: string
}
export interface StateProps {
  title: string
  description?: string
  action?: JSX.Element
}
export interface IconProps {
  token: SemanticIconTokenName
  size?: "small" | "normal" | "large"
  label?: string
}
export interface PluginUIComponents {
  Button: Component<ButtonProps>
  Input: Component<InputProps>
  Select: Component<SelectProps>
  Tabs: Component<TabsProps>
  Menu: Component<MenuProps>
  Dialog: Component<DialogProps>
  Popover: Component<PopoverProps>
  Tooltip: Component<TooltipProps>
  FormField: Component<FormFieldProps>
  SettingRow: Component<SettingRowProps>
  Loading: Component<StateProps>
  EmptyState: Component<StateProps>
  ErrorState: Component<StateProps>
  Icon: Component<IconProps>
  HostView: Component<{ shell: PluginShellService; view: PluginHostViewId }>
}

function component<K extends keyof PluginUIComponents>(name: K): PluginUIComponents[K] {
  return ((props: never) => {
    const runtime = (globalThis as typeof globalThis & { [PLUGIN_UI_RUNTIME_KEY]?: PluginUIComponents })[
      PLUGIN_UI_RUNTIME_KEY
    ]
    if (!runtime) throw new Error("Synergy UI runtime is unavailable. Mount plugin UI through a UI API 5 host.")
    return runtime[name](props)
  }) as PluginUIComponents[K]
}
export const Button = component("Button")
export const Input = component("Input")
export const Select = component("Select")
export const Tabs = component("Tabs")
export const Menu = component("Menu")
export const Dialog = component("Dialog")
export const Popover = component("Popover")
export const Tooltip = component("Tooltip")
export const FormField = component("FormField")
export const SettingRow = component("SettingRow")
export const Loading = component("Loading")
export const EmptyState = component("EmptyState")
export const ErrorState = component("ErrorState")
export const Icon = component("Icon")
export const HostView = component("HostView")
