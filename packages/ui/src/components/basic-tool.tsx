import { createEffect, createMemo, createSignal, For, Match, Show, Switch, type JSX } from "solid-js"
import { Collapsible } from "./collapsible"
import { Icon, IconProps, IconName } from "./icon"
import { Spinner } from "./spinner"
import { Countdown } from "./countdown"
import { ToolTextOutput } from "./tool-output-text"
import { classifyTool } from "./semantic-tool-classifier"

type TriggerTitleObject = {
  title: string
  titleClass?: string
  subtitle?: string
  subtitleClass?: string
  args?: string[]
  argsClass?: string
  action?: JSX.Element
}

export type TriggerTitle = TriggerTitleObject | (() => TriggerTitleObject)

const isTriggerTitle = (val: any): val is TriggerTitle => {
  if (typeof val === "function") return true
  return (
    typeof val === "object" && val !== null && "title" in val && (typeof Node === "undefined" || !(val instanceof Node))
  )
}

export interface BasicToolProps {
  icon: IconName
  trigger: TriggerTitle | JSX.Element
  children?: JSX.Element
  hideDetails?: boolean
  defaultOpen?: boolean
  forceOpen?: boolean
  status?: string
  countdown?: number
  onSubtitleClick?: () => void
}

export function BasicTool(props: BasicToolProps) {
  const [open, setOpen] = createSignal(props.defaultOpen ?? false)
  const active = () => props.status === "pending" || props.status === "running"

  createEffect(() => {
    if (props.forceOpen) setOpen(true)
  })

  const resolvedTrigger = createMemo(() => {
    const t = props.trigger
    if (typeof t === "function") return (t as () => TriggerTitleObject)()
    return isTriggerTitle(t) ? (t as TriggerTitleObject) : undefined
  })

  return (
    <Collapsible open={open()} onOpenChange={setOpen} variant="tool" data-tool-status={props.status ?? "completed"}>
      <Collapsible.Trigger>
        <div data-component="tool-trigger">
          <div data-slot="basic-tool-tool-trigger-content">
            <Icon name={props.icon} size="small" />
            <div data-slot="basic-tool-tool-info">
              <Switch>
                <Match when={resolvedTrigger()}>
                  {(trigger) => (
                    <div data-slot="basic-tool-tool-info-structured">
                      <div data-slot="basic-tool-tool-info-main">
                        <span
                          data-slot="basic-tool-tool-title"
                          classList={{
                            [trigger().titleClass ?? ""]: !!trigger().titleClass,
                          }}
                        >
                          {trigger().title}
                        </span>
                        <Show when={trigger().subtitle}>
                          <span
                            data-slot="basic-tool-tool-subtitle"
                            classList={{
                              [trigger().subtitleClass ?? ""]: !!trigger().subtitleClass,
                              clickable: !!props.onSubtitleClick,
                            }}
                            onClick={(e) => {
                              if (props.onSubtitleClick) {
                                e.stopPropagation()
                                props.onSubtitleClick()
                              }
                            }}
                          >
                            {trigger().subtitle}
                          </span>
                        </Show>
                        <Show when={trigger().args?.length}>
                          <For each={trigger().args}>
                            {(arg) => (
                              <span
                                data-slot="basic-tool-tool-arg"
                                classList={{
                                  [trigger().argsClass ?? ""]: !!trigger().argsClass,
                                }}
                              >
                                {arg}
                              </span>
                            )}
                          </For>
                        </Show>
                      </div>
                      <Show when={trigger().action}>{trigger().action}</Show>
                    </div>
                  )}
                </Match>
                <Match when={true}>{props.trigger as JSX.Element}</Match>
              </Switch>
            </div>
          </div>
          <Switch>
            <Match when={active()}>
              <Show when={props.countdown != null}>
                <Countdown seconds={props.countdown!} active={active()} />
              </Show>
              <Spinner />
            </Match>
            <Match when={props.children && !props.hideDetails}>
              <Collapsible.Arrow />
            </Match>
          </Switch>
        </div>
      </Collapsible.Trigger>
      <Show when={props.children && !props.hideDetails}>
        <Collapsible.Content>{props.children}</Collapsible.Content>
      </Show>
    </Collapsible>
  )
}

export function GenericTool(props: { tool: string; hideDetails?: boolean }) {
  return <BasicTool icon="settings" trigger={() => ({ title: props.tool })} hideDetails={props.hideDetails} />
}

/**
 * SmartTool — intelligent fallback for unregistered tools.
 *
 * Instead of showing a plain gray gear icon with just the tool name,
 * SmartTool uses semantic classification to automatically:
 * - Pick a meaningful icon based on what the tool does
 * - Extract a human-readable title
 * - Pull the most relevant subtitle from the input
 * - Show contextual args badges
 * - Display output in a scrollable pane when available
 *
 * This covers external agent tools (codex shell, cline execute_command,
 * gemini read_file), MCP tools, and any future tools — all without
 * writing a single new ToolRegistry.register() entry.
 */
export function SmartTool(props: {
  tool: string
  input: Record<string, any>
  output?: string
  status?: string
  hideDetails?: boolean
  metadata?: Record<string, any>
}) {
  const classified = createMemo(() => classifyTool(props.tool, props.input, props.metadata ?? {}))

  return (
    <BasicTool
      icon={classified().spec.icon}
      status={props.status}
      trigger={() => ({
        title: classified().title,
        subtitle: classified().subtitle,
        args: classified().args,
      })}
      hideDetails={props.hideDetails}
    >
      <Show when={props.output}>
        {(output) => (
          <div data-component="tool-output" data-scrollable>
            <ToolTextOutput text={output()} />
          </div>
        )}
      </Show>
    </BasicTool>
  )
}
