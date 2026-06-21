import { For, Show, type JSX } from "solid-js"
import { getFilename } from "@ericsanchezok/synergy-util/path"
import { Icon, type IconName } from "../icon"
import { DiffChanges } from "../diff-changes"

export interface ToolTriggerProps {
  icon: IconName
  title: string
  titleClass?: string
  subtitle?: string
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

export function ToolTrigger(props: ToolTriggerProps) {
  return (
    <div data-component="tool-trigger">
      <div data-slot="basic-tool-tool-trigger-content">
        <Icon name={props.icon} size="small" />
        <div data-slot="basic-tool-tool-info">
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <span
                data-slot="basic-tool-tool-title"
                classList={{
                  [props.titleClass ?? ""]: !!props.titleClass,
                }}
              >
                {props.title}
              </span>
              <Show when={props.subtitlePath}>
                <div data-slot="message-part-path">
                  <Show when={props.subtitlePath!.includes("/")}>
                    <span data-slot="message-part-directory">{directoryLabel(props.subtitlePath!)}</span>
                    <span data-slot="message-part-separator">/</span>
                  </Show>
                  <span data-slot="message-part-filename">{getFilename(props.subtitlePath!)}</span>
                </div>
              </Show>
              <Show when={!props.subtitlePath && props.subtitle}>
                <span
                  data-slot="basic-tool-tool-subtitle"
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
                  {props.subtitle}
                </span>
              </Show>
              <For each={props.tags ?? []}>
                {(tag) => (
                  <span
                    data-slot="basic-tool-tool-arg"
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
      </div>
      <Show when={props.changes}>
        <DiffChanges changes={props.changes!} />
      </Show>
    </div>
  )
}
