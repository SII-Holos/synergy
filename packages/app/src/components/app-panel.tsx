import type { JSX, ParentProps } from "solid-js"
import { Show, For } from "solid-js"
import { Icon, type IconName } from "@ericsanchezok/synergy-ui/icon"

function Root(props: ParentProps<{ class?: string }>) {
  return (
    <div
      class={`synergy-workbench-canvas flex h-full min-h-0 bg-background-stronger text-text-base ${props.class ?? ""}`}
    >
      {props.children}
    </div>
  )
}

function Nav(props: ParentProps) {
  return (
    <div class="shrink-0 w-[224px] border-r border-border-weaker-base/70 flex flex-col overflow-hidden bg-background-base">
      {props.children}
    </div>
  )
}

function NavSection(props: { label: string; children: JSX.Element }) {
  return (
    <div class="flex flex-col gap-0.5 px-2 pb-3">
      <div class="text-11-medium text-text-weaker px-2.5 pt-4 pb-1.5 uppercase tracking-wide">{props.label}</div>
      {props.children}
    </div>
  )
}

function NavItem(props: { icon: IconName; label: string; active?: boolean; badge?: JSX.Element; onClick: () => void }) {
  return (
    <button
      type="button"
      classList={{
        "flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-13-medium transition-colors w-full text-left": true,
        "workbench-selected-surface bg-surface-raised-base text-text-strong shadow-sm": props.active,
        "text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover": !props.active,
      }}
      onClick={props.onClick}
    >
      <Icon name={props.icon} size="small" class="shrink-0" />
      <span class="flex-1 truncate">{props.label}</span>
      {props.badge}
    </button>
  )
}

function Content(props: ParentProps<{ class?: string }>) {
  return <div class={`flex flex-col flex-1 min-w-0 min-h-0 ${props.class ?? ""}`}>{props.children}</div>
}

function Header(props: ParentProps<{ class?: string }>) {
  return (
    <div
      class={`shrink-0 px-6 pt-6 pb-3 flex flex-col gap-3.5 border-b border-border-weaker-base/40 ${props.class ?? ""}`}
      style={{ animation: "fadeUp 0.3s ease-out both" }}
    >
      {props.children}
    </div>
  )
}

function HeaderRow(props: ParentProps) {
  return <div class="flex items-center gap-2">{props.children}</div>
}

function Title(props: { children: JSX.Element }) {
  return <span class="text-15-medium text-text-strong flex-1">{props.children}</span>
}

function Subtitle(props: { children: JSX.Element }) {
  return <span class="text-12-regular text-text-weak -mt-1">{props.children}</span>
}

function Actions(props: ParentProps) {
  return <div class="flex items-center gap-1">{props.children}</div>
}

function Action(props: { icon: IconName; label?: string; title?: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      classList={{
        "flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-13-medium transition-colors": true,
        "text-icon-weak-base hover:text-icon-base hover:bg-surface-raised-base-hover": !props.disabled,
        "text-icon-weak-base": !!props.disabled,
      }}
      disabled={props.disabled}
      onClick={props.onClick}
      title={props.title ?? props.label}
    >
      <Icon name={props.icon} size="small" />
      <Show when={props.label}>
        <span>{props.label}</span>
      </Show>
    </button>
  )
}

function Body(props: ParentProps<{ class?: string; padding?: boolean }>) {
  const px = props.padding === false ? "" : "px-6"
  return (
    <div
      class={`flex-1 min-h-0 overflow-y-auto ${px} pb-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${props.class ?? ""}`}
      style={{ animation: "fadeUp 0.35s ease-out 0.05s both" }}
    >
      {props.children}
    </div>
  )
}

function Footer(props: ParentProps<{ class?: string }>) {
  return (
    <div
      class={`shrink-0 px-6 py-3 border-t border-border-weaker-base/40 flex items-center gap-2 ${props.class ?? ""}`}
    >
      {props.children}
    </div>
  )
}

function Section(props: { label: string; actions?: JSX.Element; children: JSX.Element }) {
  return (
    <div class="flex flex-col gap-2.5">
      <div class="flex items-center justify-between px-0.5 mt-4 first:mt-0 mb-1">
        <span class="text-12-medium text-text-weak">{props.label}</span>
        {props.actions}
      </div>
      {props.children}
    </div>
  )
}

function Card(props: {
  icon?: IconName
  title: string
  subtitle?: string
  trailing?: JSX.Element
  active?: boolean
  onClick?: () => void
  children?: JSX.Element
}) {
  const isClickable = !!props.onClick
  const Tag = isClickable ? "button" : "div"
  return (
    <Tag
      type={isClickable ? "button" : undefined}
      classList={{
        "flex items-center gap-3 px-3.5 py-3 rounded-xl text-left w-full transition-colors": true,
        "workbench-selected-surface bg-surface-raised-base text-text-strong": props.active,
        "hover:bg-surface-raised-base-hover cursor-pointer": isClickable && !props.active,
        "cursor-default": !isClickable,
      }}
      onClick={props.onClick}
    >
      <Show when={props.icon}>
        <Icon name={props.icon!} size="normal" class="text-icon-weak-base shrink-0" />
      </Show>
      <div class="flex-1 min-w-0">
        <div class="text-14-medium text-text-strong truncate">{props.title}</div>
        <Show when={props.subtitle}>
          <div class="text-12-regular text-text-weaker truncate mt-0.5">{props.subtitle}</div>
        </Show>
      </div>
      <Show when={props.trailing}>
        <div class="shrink-0">{props.trailing}</div>
      </Show>
      {props.children}
    </Tag>
  )
}

function CardList(props: ParentProps<{ cols?: 1 | 2 }>) {
  const cols = props.cols ?? 1
  return (
    <div
      classList={{
        "grid gap-1.5": true,
        "grid-cols-1": cols === 1,
        "grid-cols-1 md:grid-cols-2": cols === 2,
      }}
    >
      {props.children}
    </div>
  )
}

function SegmentedNav(props: {
  items: { id: string; label: string }[]
  active: string
  onChange: (id: string) => void
}) {
  return (
    <div class="flex items-center gap-0.5 rounded-lg bg-surface-inset-base p-0.5 self-start ring-1 ring-inset ring-border-weaker-base/55">
      <For each={props.items}>
        {(item) => (
          <button
            type="button"
            classList={{
              "px-3 py-1.5 rounded-md text-13-medium transition-colors": true,
              "workbench-selected-surface bg-surface-raised-base text-text-strong shadow-sm": props.active === item.id,
              "text-text-weak hover:text-text-base": props.active !== item.id,
            }}
            onClick={() => props.onChange(item.id)}
          >
            {item.label}
          </button>
        )}
      </For>
    </div>
  )
}

function Empty(props: { icon: IconName; title: string; description?: string; action?: JSX.Element }) {
  return (
    <div
      class="flex flex-col items-center justify-center py-16 gap-3"
      style={{ animation: "fadeUp 0.4s ease-out 0.1s both" }}
    >
      <Icon name={props.icon} size="large" class="text-icon-weak-base" />
      <div class="text-center">
        <div class="text-14-medium text-text-weak">{props.title}</div>
        <Show when={props.description}>
          <div class="text-12-regular text-text-weaker mt-1 max-w-64">{props.description}</div>
        </Show>
      </div>
      <Show when={props.action}>{props.action}</Show>
    </div>
  )
}

function Loading() {
  return (
    <div class="flex items-center justify-center py-16">
      <div class="size-5 rounded-full border-2 border-border-weaker-base border-t-text-base animate-spin" />
    </div>
  )
}

export const AppPanel = {
  Root,
  Nav,
  NavSection,
  NavItem,
  Content,
  Header,
  HeaderRow,
  Title,
  Subtitle,
  Actions,
  Action,
  Body,
  Footer,
  Section,
  Card,
  CardList,
  SegmentedNav,
  Empty,
  Loading,
}
