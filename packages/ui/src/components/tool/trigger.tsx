import { For, Show, type JSX } from "solid-js"
import type { MessageDescriptor } from "@lingui/core"
import { useLingui } from "@lingui/solid"
import { getFilename } from "@ericsanchezok/synergy-util/path"
import { Icon, type IconName } from "../icon"
import { DiffChanges } from "../diff-changes"

export interface ToolTriggerProps {
  icon: IconName
  title: string | MessageDescriptor
  titleClass?: string
  subtitle?: string | MessageDescriptor
  subtitleClass?: string
  /** When set, renders a path with directory/filename split instead of plain subtitle */
  subtitlePath?: string
  tags?: Array<{ label: string; tone?: "default" | "success" | "warning" | "danger" }>
  argsClass?: string
  action?: JSX.Element
  onSubtitleClick?: () => void
  changes?: { additions: number; deletions: number } | { additions: number; deletions: number }[]
}

function directoryLabel(path: string): string {
  const idx = path.lastIndexOf("/")
  if (idx === -1) return ""
  return path.slice(0, idx).replace(/\/$/, "")
}

function resolveDescriptor(value: string | MessageDescriptor, _: (desc: MessageDescriptor) => string): string {
  if (typeof value === "string") return value
  return _(value)
}

export function ToolTrigger(props: ToolTriggerProps) {
  const { _ } = useLingui()
  const title = () => resolveDescriptor(props.title, _)
  const subtitle = () => (props.subtitle ? resolveDescriptor(props.subtitle, _) : undefined)
  return (
    <div data-component="tool-trigger">
      <div data-slot="tool-trigger-left">
        <Icon name={props.icon} size="small" />
        <div data-slot="tool-trigger-info">
          <div data-slot="tool-trigger-info-main">
            <span
              data-slot="tool-trigger-title"
              classList={{
                [props.titleClass ?? ""]: !!props.titleClass,
              }}
            >
              {title()}
            </span>
            <Show when={props.subtitlePath}>
              <div data-slot="tool-trigger-path">
                <Show when={props.subtitlePath!.includes("/")}>
                  <span data-slot="tool-trigger-path-dir">{directoryLabel(props.subtitlePath!)}</span>
                  <span data-slot="tool-trigger-path-sep">/</span>
                </Show>
                <span data-slot="tool-trigger-path-file">{getFilename(props.subtitlePath!)}</span>
              </div>
            </Show>
            <Show when={!props.subtitlePath && subtitle()}>
              <span
                data-slot="tool-trigger-subtitle"
                classList={{
                  [props.subtitleClass ?? ""]: !!props.subtitleClass,
                  clickable: !!props.onSubtitleClick,
                }}
                onClick={(e) => {
                  if (props.onSubtitleClick) {
                    e.stopPropagation()
                    props.onSubtitleClick()
                  }
                }}
              >
                {subtitle()}
              </span>
            </Show>
            <For each={props.tags ?? []}>
              {(tag) => (
                <span
                  data-slot="tool-trigger-tag"
                  data-tone={tag.tone ?? "default"}
                  classList={{
                    [props.argsClass ?? ""]: !!props.argsClass,
                  }}
                >
                  {tag.label}
                </span>
              )}
            </For>
          </div>
          <Show when={props.action}>{props.action}</Show>
        </div>
      </div>
      <Show when={props.changes}>
        <div data-slot="tool-trigger-right">
          <DiffChanges changes={props.changes!} />
        </div>
      </Show>
    </div>
  )
}
