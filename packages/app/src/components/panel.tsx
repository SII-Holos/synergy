import type { JSX, ParentProps } from "solid-js"
import { Show } from "solid-js"
import { Icon, type IconName } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"

function Root(props: ParentProps) {
  return <div class="flex flex-col h-full">{props.children}</div>
}

function Header(props: ParentProps) {
  return (
    <div class="shrink-0 px-6 pt-6 pb-3 flex flex-col gap-3.5" style={{ animation: "fadeUp 0.3s ease-out both" }}>
      {props.children}
    </div>
  )
}

function SubHeader(props: ParentProps) {
  return <div class="shrink-0 px-6 pb-3 flex flex-col gap-2.5">{props.children}</div>
}

function HeaderRow(props: ParentProps) {
  return <div class="flex items-center gap-2">{props.children}</div>
}

function Title(props: { children: JSX.Element }) {
  return <span class="text-14-medium text-text-strong flex-1">{props.children}</span>
}

function Count(props: { children: JSX.Element }) {
  return <span class="text-11-regular text-text-weak mr-0.5">{props.children}</span>
}

function Actions(props: ParentProps) {
  return <div class="flex items-center gap-1">{props.children}</div>
}

function Action(props: { icon: IconName; title?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      class="flex items-center justify-center size-7 rounded-lg text-icon-weak hover:text-icon-base hover:bg-surface-raised-base-hover transition-colors"
      onClick={props.onClick}
      title={props.title}
    >
      <Icon name={props.icon} size="small" />
    </button>
  )
}

function Search(props: {
  value: string
  onInput: (value: string) => void
  placeholder?: string
  trailing?: JSX.Element
}) {
  return (
    <div class="flex items-center gap-2.5 rounded-xl bg-surface-inset-base/60 px-3.5 py-2.5 transition-colors">
      <Icon name="search" size="small" class="text-icon-weak shrink-0" />
      <input
        type="text"
        placeholder={props.placeholder ?? "Search..."}
        class="flex-1 bg-transparent text-13-regular text-text-base placeholder:text-text-weak outline-none"
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.value)}
      />
      <Show when={props.value}>
        <button
          type="button"
          class="flex items-center justify-center size-5 rounded-md text-icon-weak hover:text-icon-base transition-colors"
          onClick={() => props.onInput("")}
        >
          <Icon name="x" size="small" />
        </button>
      </Show>
      {props.trailing}
    </div>
  )
}

function Body(props: ParentProps<{ class?: string; padding?: "normal" | "tight" }>) {
  const px = () => (props.padding === "tight" ? "px-5" : "px-6")
  return (
    <div
      class={`flex-1 min-h-0 overflow-y-auto ${px()} pb-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${props.class ?? ""}`}
      style={{ animation: "fadeUp 0.35s ease-out 0.05s both" }}
    >
      {props.children}
    </div>
  )
}

function SectionLabel(props: { children: JSX.Element }) {
  return <div class="text-12-medium text-text-weak mt-5 mb-2.5 px-0.5">{props.children}</div>
}

function Empty(props: { icon: IconName; title: string; description?: string }) {
  return (
    <div
      class="flex flex-col items-center justify-center py-16 gap-3"
      style={{ animation: "fadeUp 0.4s ease-out 0.1s both" }}
    >
      <Icon
        name={props.icon}
        size="large"
        class="text-icon-weak"
        style={{ animation: "breathe 4s ease-in-out infinite" }}
      />
      <div class="text-center">
        <div class="text-14-medium text-text-weak">{props.title}</div>
        <Show when={props.description}>
          <div class="text-12-regular text-text-weaker mt-1 max-w-64">{props.description}</div>
        </Show>
      </div>
    </div>
  )
}

function Loading() {
  return (
    <div class="flex items-center justify-center py-16">
      <Spinner class="size-5" />
    </div>
  )
}

function FilterChip(props: { active: boolean; onClick: () => void; children: JSX.Element }) {
  return (
    <button
      type="button"
      classList={{
        "px-2.5 py-1 rounded-lg text-12-medium transition-colors": true,
        "bg-surface-raised-base-hover text-text-strong": props.active,
        "text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover": !props.active,
      }}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

export const Panel = {
  Root,
  Header,
  SubHeader,
  HeaderRow,
  Title,
  Count,
  Actions,
  Action,
  Search,
  Body,
  SectionLabel,
  Empty,
  Loading,
  FilterChip,
}
